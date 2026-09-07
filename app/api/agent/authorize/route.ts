import { NextRequest, NextResponse, after } from "next/server";
import { getMandateByToken, authorize, factsFor, reserveIdempotent, completeIdempotent, releaseIdempotent, MAX_AMOUNT } from "@/lib/service";
import { fmt } from "@/lib/policy";
import { rateLimit, clientIp } from "@/lib/ratelimit";
import { logger } from "@/lib/log";

// The token-based agent endpoint, for agents you run yourself. The agent
// holds a mandate token, never the real card or key. It asks before
// spending; we answer approved / declined / pending.
//
//   POST /api/agent/authorize
//   Authorization: Bearer mnd_...
//   Idempotency-Key: <any unique string per purchase attempt>   (recommended)
//   { "amount": 1299, "merchant": "OpenAI", "purpose": "API credits", "category": "computer_software_stores" }

type Body = { amount?: unknown; merchant?: unknown; category?: unknown; purpose?: unknown; currency?: unknown };

function str(v: unknown, max: number): string | null {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") return null;
  return v.trim().slice(0, max);
}

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const log = logger(req, "agent_api");
  const ip = await rateLimit(`ip:${clientIp(req)}:agent`, 600);
  if (!ip.ok) return NextResponse.json({ error: "Too many requests from this address." }, { status: 429, headers: { "retry-after": String(ip.resetSec) } });
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token.startsWith("mnd_")) return NextResponse.json({ error: "Missing mandate token. Send it as Authorization: Bearer mnd_..." }, { status: 401 });
  const m = await getMandateByToken(token);
  if (!m) { log.warn("auth.unknown_token"); return NextResponse.json({ error: "Unknown mandate token." }, { status: 401 }); }
  const rl = await rateLimit(`mandate:${m.id}:agent`, 120);
  if (!rl.ok) return NextResponse.json({ error: "This mandate is being called too fast; slow down." }, { status: 429, headers: { "retry-after": String(rl.resetSec) } });

  let body: Body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Body must be JSON." }, { status: 400 }); }
  const amount = body.amount;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0 || amount > MAX_AMOUNT) {
    return NextResponse.json({ error: `amount must be a positive integer in minor units (e.g. 1299 for $12.99), at most ${MAX_AMOUNT}.` }, { status: 400 });
  }
  const merchant = str(body.merchant, 120);
  const purpose = str(body.purpose, 300);
  const category = str(body.category, 64);
  const currency = str(body.currency, 3);
  if (!merchant) return NextResponse.json({ error: "merchant is required and must be a string." }, { status: 400 });
  if (purpose === null || category === null || currency === null) return NextResponse.json({ error: "purpose, category and currency must be strings when given." }, { status: 400 });
  if (currency && currency.toUpperCase() !== m.currency) return NextResponse.json({ error: `This mandate is denominated in ${m.currency}.` }, { status: 400 });

  const idem = (req.headers.get("idempotency-key") ?? "").trim().slice(0, 128);
  if (idem) {
    const r = await reserveIdempotent(m.id, idem);
    if (r.kind === "replay") return NextResponse.json(JSON.parse(r.response), { status: r.status, headers: { "Idempotent-Replayed": "true" } });
    if (r.kind === "in_progress") return NextResponse.json({ error: "A request with this Idempotency-Key is still being decided. Retry in a moment." }, { status: 409, headers: { "retry-after": "1" } });
  }

  let r;
  try {
    // Notifications go out after the response: the agent gets its answer
    // in milliseconds even when an email provider is slow.
    r = await authorize(m, { amount, merchant, category, purpose }, "agent_api", { actor: `token ${m.tokenPrefix}…`, background: (w) => after(w) });
  } catch (e) {
    if (idem) await releaseIdempotent(m.id, idem).catch(() => {});
    log.error("authorize.failed", { message: (e as Error).message });
    return NextResponse.json({ error: "Authorisation could not be decided; nothing was approved. Retry shortly." }, { status: 503 });
  }
  const status = r.decision === "declined" ? 403 : r.decision === "pending" ? 202 : 200;
  const responseBody: Record<string, unknown> = {
    decision: r.decision, reason: r.reason, rule: r.rule, transactionId: r.transactionId, approvalId: r.approvalId ?? null,
    next: r.decision === "pending" ? "The owner is being notified. Wait for approval, then retry the same request with the same Idempotency-Key." : undefined,
  };
  // The decision is committed: record the terminal answer before anything
  // else can fail, so a retry can only ever replay it. "pending" is not an
  // answer to remember — the retry must re-evaluate to consume the approval.
  if (idem) { if (r.decision === "pending") await releaseIdempotent(m.id, idem); else await completeIdempotent(m.id, idem, status, responseBody); }
  try {
    const f = await factsFor(m);
    responseBody.remaining = { today: Math.max(0, m.dailyLimit - f.spentToday), total: Math.max(0, m.totalLimit - f.spentTotal), perTransaction: m.perTxnLimit, currency: m.currency, todayDisplay: fmt(Math.max(0, m.dailyLimit - f.spentToday), m.currency) };
    if (idem && r.decision !== "pending") await completeIdempotent(m.id, idem, status, responseBody);
  } catch (e) { log.warn("facts.failed", { message: (e as Error).message }); }
  log.info("decision", { mandateId: m.id, decision: r.decision, rule: r.rule, amount, merchant });
  return NextResponse.json(responseBody, { status, headers: { "x-request-id": log.id } });
}
