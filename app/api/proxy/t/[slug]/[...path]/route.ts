import { NextRequest, NextResponse } from "next/server";
import { resolveTargetToken, forwardableTargetHeader, preauthorizeTarget, settleTarget, targetCost, recordDeclined } from "@/lib/proxy";
import { rateLimit, clientIp } from "@/lib/ratelimit";
import { logger } from "@/lib/log";

export const maxDuration = 300;

// The generic API proxy. Any HTTP API a workspace has added as a target
// (Settings → API proxy → Custom targets) can be called through
//   <method> https://your-mandate/api/proxy/t/<slug>/<path>
//   Authorization: Bearer mpx_…      (or x-mandate-key: mpx_…)
// The real credential is injected server-side; every call is authorised
// against the mandate at the target's per-call price before it is forwarded
// and settled on the cost the response reports (header or JSON path), or
// at the per-call price. A mandate's merchant list, hours, limits, veto and
// approval thresholds all apply, so a scraping API or a data vendor is
// governed exactly like a purchase.

const MAX_BODY = 8 * 1024 * 1024;

function err(status: number, message: string, code: string, extra: Record<string, string> = {}) {
  return NextResponse.json({ error: { message, type: code } }, { status, headers: { "x-mandate-error": code, ...extra } });
}

async function handle(req: NextRequest, ctx: { params: Promise<{ slug: string; path: string[] }> }) {
  const { slug, path } = await ctx.params;
  if (!/^[a-z0-9-]{1,40}$/.test(slug)) return err(404, "Unknown target.", "not_found");
  if (path.some((seg) => seg === "" || seg === "." || seg === ".." || seg.includes("\\"))) return err(404, "Bad path.", "not_found");
  const upstreamPath = path.join("/");
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const token = [req.headers.get("x-mandate-key") ?? "", bearer].find((c) => c.startsWith("mpx_")) ?? "";
  if (!token) return err(401, "Missing Mandate proxy key (mpx_…). Send it as Authorization: Bearer or x-mandate-key.", "authentication_error");
  const log = logger(req, "proxy");
  const ipl = await rateLimit(`ip:${clientIp(req)}:proxy`, 600);
  if (!ipl.ok) return err(429, "Too many requests from this address.", "rate_limit_error");
  const r = await resolveTargetToken(token, slug);
  if (!r) { log.warn("proxy.unknown_target_key", { slug }); return err(401, "Unknown or revoked proxy key for this target.", "authentication_error"); }
  const kl = await rateLimit(`proxykey:${r.proxyKey.id}`, 300);
  if (!kl.ok) return err(429, "This proxy key is being used too fast; slow down.", "rate_limit_error");

  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();
  if (body && body.length > MAX_BODY) return err(413, "Request body too large for the proxy (8 MB).", "invalid_request_error");
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => { if (forwardableTargetHeader(k)) headers[k] = v; });
  headers[r.target.authHeader] = r.authValue;
  const url = `${r.target.baseUrl}/${upstreamPath}${req.nextUrl.search}`;

  const { auth, callId } = await preauthorizeTarget(r, req.method, upstreamPath);
  log.info("proxy.target_decision", { slug, decision: auth.decision, rule: auth.rule, mandateId: r.mandate.id, amount: r.target.priceAmount });
  if (auth.decision !== "approved") {
    await recordDeclined(r, callId, 0);
    const extra: Record<string, string> = { "x-mandate-rule": auth.rule };
    if (auth.remedy?.retryAt) extra["x-mandate-retry-at"] = auth.remedy.retryAt;
    if (auth.remedy?.maxAmountNow != null) extra["x-mandate-max-now"] = String(auth.remedy.maxAmountNow);
    return err(auth.decision === "pending" ? 402 : 403, `Mandate ${auth.decision}: ${auth.reason}${auth.remedy ? " " + auth.remedy.message : ""}`, auth.decision === "pending" ? "mandate_pending_approval" : "mandate_declined", extra);
  }

  let upstream: Response;
  try {
    upstream = await fetch(url, { method: req.method, headers, body, redirect: "manual" });
  } catch (e) {
    await settleTarget(r, callId, auth.transactionId, 502, { amount: 0, source: "unreachable" });
    return err(502, `Could not reach ${r.target.name}: ${(e as Error).message}`, "upstream_unreachable");
  }
  const out = new Headers();
  for (const name of ["content-type", "cache-control", "etag", "last-modified", "retry-after", "x-request-id"]) { const v = upstream.headers.get(name); if (v) out.set(name, v); }
  out.set("x-mandate-transaction", auth.transactionId);
  out.set("x-mandate-authorized", String(r.target.priceAmount));
  const ct = upstream.headers.get("content-type") ?? "";
  if (ct.includes("text/event-stream") && upstream.body) {
    // Streams settle when they end, at the header-reported cost or the per-call price.
    let settled = false;
    const finish = async () => { if (settled) return; settled = true; await settleTarget(r, callId, auth.transactionId, upstream.status, targetCost(r.target, { status: upstream.status, headers: upstream.headers, body: null })); };
    const ts = new TransformStream<Uint8Array, Uint8Array>({ async flush() { await finish(); } });
    req.signal.addEventListener("abort", () => { void finish(); });
    return new Response(upstream.body.pipeThrough(ts), { status: upstream.status, headers: out });
  }
  const buf = Buffer.from(await upstream.arrayBuffer());
  const text = /json|text/.test(ct) ? buf.toString("utf8") : null;
  const cost = targetCost(r.target, { status: upstream.status, headers: upstream.headers, body: text });
  await settleTarget(r, callId, auth.transactionId, upstream.status, cost);
  out.set("x-mandate-settled", String(upstream.status >= 200 && upstream.status < 300 ? Math.min(cost.amount, r.target.priceAmount) : 0));
  return new Response(buf, { status: upstream.status, headers: out });
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
