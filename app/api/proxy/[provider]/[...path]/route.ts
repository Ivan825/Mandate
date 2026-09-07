import { NextRequest, NextResponse } from "next/server";
import { PROVIDERS, isProvider, classifyRoute, FORWARD_REQUEST_HEADERS, FORWARD_RESPONSE_HEADERS, resolveProxyToken, estimateRequest, preauthorize, settle, recordDeclined, parseUsage } from "@/lib/proxy";
import type { Provider } from "@/lib/pricing";
import { rateLimit, clientIp } from "@/lib/ratelimit";
import { logger } from "@/lib/log";

export const maxDuration = 300;

// POST https://your-mandate/api/proxy/{openai|anthropic|gemini}/<provider path>
// Auth: the proxy key in the place the provider's SDK puts its key —
//   OpenAI:    Authorization: Bearer mpx_…
//   Anthropic: x-api-key: mpx_…
//   Gemini:    x-goog-api-key: mpx_…   (or ?key=mpx_…)
// Point the SDK's base URL here and change nothing else. Only generation,
// embedding and model-listing endpoints are forwarded.

const MAX_BODY = 8 * 1024 * 1024;

function tokenFrom(req: NextRequest, provider: Provider): string {
  const h = req.headers;
  const bearer = (h.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const candidates = provider === "openai" ? [bearer] : provider === "anthropic" ? [h.get("x-api-key") ?? "", bearer] : [h.get("x-goog-api-key") ?? "", req.nextUrl.searchParams.get("key") ?? "", bearer];
  return candidates.find((c) => c.startsWith("mpx_")) ?? "";
}

// Errors are shaped like the provider's own so SDKs surface them cleanly.
function providerError(provider: Provider, status: number, message: string, code: string) {
  const body = provider === "anthropic" ? { type: "error", error: { type: code, message } } : provider === "gemini" ? { error: { code: status, message, status: code.toUpperCase() } } : { error: { message, type: code, code } };
  return NextResponse.json(body, { status, headers: { "x-mandate-error": code } });
}

function responseHeaders(upstream: Response): Headers {
  const h = new Headers();
  for (const name of FORWARD_RESPONSE_HEADERS) { const v = upstream.headers.get(name); if (v) h.set(name, v); }
  return h;
}

async function handle(req: NextRequest, ctx: { params: Promise<{ provider: string; path: string[] }> }) {
  const { provider: p, path } = await ctx.params;
  if (!isProvider(p)) return NextResponse.json({ error: "Unknown provider. Use openai, anthropic or gemini." }, { status: 404 });
  const provider = p;
  const upstreamPath = path.join("/");
  const kind = classifyRoute(provider, req.method, upstreamPath);
  if (!kind) return providerError(provider, 404, `The Mandate proxy forwards only generation, embedding and model-listing endpoints; ${req.method} /${upstreamPath} is not one of them.`, "not_found_error");
  const token = tokenFrom(req, provider);
  if (!token) return providerError(provider, 401, "Missing Mandate proxy key (mpx_…). Put it where the SDK expects the provider key.", "authentication_error");
  const log = logger(req, "proxy");
  const ipl = await rateLimit(`ip:${clientIp(req)}:proxy`, 600);
  if (!ipl.ok) return providerError(provider, 429, "Too many requests from this address.", "rate_limit_error");
  const r = await resolveProxyToken(token);
  if (!r) { log.warn("proxy.unknown_key"); return providerError(provider, 401, "Unknown or revoked Mandate proxy key.", "authentication_error"); }
  const kl = await rateLimit(`proxykey:${r.proxyKey.id}`, 300);
  if (!kl.ok) return providerError(provider, 429, "This proxy key is being used too fast; slow down.", "rate_limit_error");

  const search = new URLSearchParams(req.nextUrl.searchParams);
  search.delete("key");
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => { if (FORWARD_REQUEST_HEADERS.has(k.toLowerCase())) headers[k] = v; });
  Object.assign(headers, PROVIDERS[provider].authHeader(r.realKey));
  const url = `${PROVIDERS[provider].base}/${upstreamPath}${search.toString() ? "?" + search.toString() : ""}`;

  if (kind === "free") {
    // Model listings and token counts: nothing to authorise or settle.
    try {
      const body = req.method === "GET" ? undefined : await req.text();
      if (body && body.length > MAX_BODY) return providerError(provider, 413, "Request body too large for the proxy (8 MB).", "invalid_request_error");
      const upstream = await fetch(url, { method: req.method, headers, body, redirect: "manual" });
      return new Response(await upstream.text(), { status: upstream.status, headers: responseHeaders(upstream) });
    } catch (e) {
      return providerError(provider, 502, `Could not reach ${PROVIDERS[provider].name}: ${(e as Error).message}`, "upstream_unreachable");
    }
  }

  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY) return providerError(provider, 413, "Request body too large for the proxy (8 MB).", "invalid_request_error");
  let json: unknown = null;
  if (rawBody) { try { json = JSON.parse(rawBody); } catch { json = null; } }
  if (!json || typeof json !== "object") return providerError(provider, 400, "Body must be a JSON object.", "invalid_request_error");

  // Ask OpenAI streams to report usage so settlement is exact.
  let forwardBody = rawBody;
  if (provider === "openai" && (json as Record<string, unknown>).stream === true && /chat\/completions|responses|completions/.test(upstreamPath)) {
    const j = json as Record<string, unknown>;
    if (!j.stream_options) forwardBody = JSON.stringify({ ...j, stream_options: { include_usage: true } });
  }

  const est = estimateRequest(provider, upstreamPath, json);
  const { auth, callId } = await preauthorize(r, est, upstreamPath);
  log.info("proxy.decision", { provider, model: est.model, estimateCents: est.cents, decision: auth.decision, rule: auth.rule, mandateId: r.mandate.id });
  if (auth.decision !== "approved") {
    await recordDeclined(r, callId, 0);
    const status = auth.decision === "pending" ? 402 : 403;
    return providerError(provider, status, `Mandate ${auth.decision}: ${auth.reason}${auth.decision === "pending" ? " The owner has been notified; retry after approval." : ""}`, auth.decision === "pending" ? "mandate_pending_approval" : "mandate_declined");
  }

  let upstream: Response;
  try {
    upstream = await fetch(url, { method: "POST", headers, body: forwardBody, redirect: "manual" });
  } catch (e) {
    await settle(r, callId, auth.transactionId, 502, null, est);
    return providerError(provider, 502, `Could not reach ${PROVIDERS[provider].name}: ${(e as Error).message}`, "upstream_unreachable");
  }

  const respHeaders = responseHeaders(upstream);
  respHeaders.set("x-mandate-transaction", auth.transactionId);
  respHeaders.set("x-mandate-estimate-cents", String(est.cents));

  const ct = upstream.headers.get("content-type") ?? "";
  if (ct.includes("text/event-stream") && upstream.body) {
    // Pass the stream through untouched; keep a copy of the text to settle
    // from. If the agent disconnects mid-stream the upstream keeps billing
    // for what it generated, so settle on whatever usage reached us, or the
    // estimate when the usage frame never arrived.
    let acc = "";
    let settled = false;
    const dec = new TextDecoder();
    const status = upstream.status;
    const finish = async () => { if (settled) return; settled = true; await settle(r, callId, auth.transactionId, status, parseUsage(provider, acc), est); };
    const ts = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) { if (acc.length < 2_000_000) acc += dec.decode(chunk, { stream: true }); controller.enqueue(chunk); },
      async flush() { await finish(); },
    });
    req.signal.addEventListener("abort", () => { void finish(); });
    return new Response(upstream.body.pipeThrough(ts), { status, headers: respHeaders });
  }

  const text = await upstream.text();
  await settle(r, callId, auth.transactionId, upstream.status, parseUsage(provider, text), est);
  return new Response(text, { status: upstream.status, headers: respHeaders });
}

export const POST = handle;
export const GET = handle;
