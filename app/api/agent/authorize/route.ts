import { NextRequest, NextResponse } from "next/server";
import { getMandateByToken, authorize, factsFor, getIdempotent, putIdempotent } from "@/lib/service";
import { fmt } from "@/lib/policy";

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

export async function POST(req: NextRequest) {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token.startsWith("mnd_")) return NextResponse.json({ error: "Missing mandate token. Send it as Authorization: Bearer mnd_..." }, { status: 401 });
  const m = await getMandateByToken(token);
  if (!m) return NextResponse.json({ error: "Unknown mandate token." }, { status: 401 });

  let body: Body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Body must be JSON." }, { status: 400 }); }
  const amount = body.amount;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0 || amount > 1e12) {
    return NextResponse.json({ error: "amount must be a positive integer in minor units (e.g. 1299 for $12.99)." }, { status: 400 });
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
    const prior = await getIdempotent(m.id, idem);
    if (prior) return NextResponse.json(JSON.parse(prior.response), { status: prior.status, headers: { "Idempotent-Replayed": "true" } });
  }

  try {
    const r = await authorize(m, { amount, merchant, category, purpose }, "agent_api", { actor: `token ${m.tokenPrefix}…` });
    const f = await factsFor(m);
    const status = r.decision === "declined" ? 403 : r.decision === "pending" ? 202 : 200;
    const responseBody = {
      decision: r.decision, reason: r.reason, rule: r.rule, transactionId: r.transactionId, approvalId: r.approvalId ?? null,
      remaining: { today: Math.max(0, m.dailyLimit - f.spentToday), total: Math.max(0, m.totalLimit - f.spentTotal), perTransaction: m.perTxnLimit, currency: m.currency, todayDisplay: fmt(Math.max(0, m.dailyLimit - f.spentToday), m.currency) },
      notified: r.notified ?? false,
      next: r.decision === "pending" ? "Wait for the owner to approve, then retry the same request." : undefined,
    };
    if (idem) await putIdempotent(m.id, idem, status, responseBody);
    return NextResponse.json(responseBody, { status });
  } catch (e) {
    console.error("authorize failed:", (e as Error).message);
    return NextResponse.json({ error: "Authorisation could not be decided; nothing was approved. Retry shortly." }, { status: 503 });
  }
}
