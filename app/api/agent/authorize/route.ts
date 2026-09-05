import { NextRequest, NextResponse } from "next/server";
import { getMandateByToken, authorize, factsFor } from "@/lib/service";
import { fmt } from "@/lib/policy";

// The agent-facing endpoint. The agent holds a mandate token, never the
// real card or key. It asks before spending; we answer approved / declined /
// pending. On "pending" the human sees it in their inbox, and the agent
// retries after approval.
//
//   POST /api/agent/authorize
//   Authorization: Bearer mnd_...
//   { "amount": 1299, "merchant": "OpenAI", "purpose": "API credits", "category": "computer_software_stores" }

export async function POST(req: NextRequest) {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token.startsWith("mnd_")) return NextResponse.json({ error: "Missing mandate token. Send it as Authorization: Bearer mnd_..." }, { status: 401 });
  const m = await getMandateByToken(token);
  if (!m) return NextResponse.json({ error: "Unknown mandate token." }, { status: 401 });

  let body: { amount?: number; merchant?: string; category?: string; purpose?: string; currency?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Body must be JSON." }, { status: 400 }); }
  if (typeof body.amount !== "number" || !body.merchant) return NextResponse.json({ error: "amount (minor units, integer) and merchant are required." }, { status: 400 });
  if (body.currency && body.currency.toUpperCase() !== m.currency) return NextResponse.json({ error: `This mandate is denominated in ${m.currency}.` }, { status: 400 });

  const r = await authorize(m, { amount: body.amount, merchant: body.merchant, category: body.category, purpose: body.purpose }, "agent_api");
  const f = await factsFor(m);
  return NextResponse.json({
    decision: r.decision,
    reason: r.reason,
    rule: r.rule,
    transactionId: r.transactionId,
    approvalId: r.approvalId ?? null,
    remaining: {
      today: Math.max(0, m.dailyLimit - f.spentToday),
      total: Math.max(0, m.totalLimit - f.spentTotal),
      perTransaction: m.perTxnLimit,
      currency: m.currency,
      todayDisplay: fmt(Math.max(0, m.dailyLimit - f.spentToday), m.currency),
    },
    next: r.decision === "pending" ? "Wait for the owner to approve, then retry the same request." : undefined,
  }, { status: r.decision === "declined" ? 403 : r.decision === "pending" ? 202 : 200 });
}
