import { NextRequest, NextResponse } from "next/server";
import { captureTransaction, factsFor, settlementView } from "@/lib/service";
import { authenticateMandate, readJson } from "@/lib/agent-auth";
import { logger } from "@/lib/log";

// The agent reports what it actually paid against an approved hold.
//
//   POST /api/agent/capture
//   Authorization: Bearer mnd_...
//   { "transactionId": "…", "amount": 940, "note": "order #1234 shipped" }
//
// amount defaults to the full authorised amount; less releases the
// difference back to the limits; more is refused (authorise again). A hold
// can be captured once. 200 with the settled state; 409 if it is no longer
// held (the current state is returned, so a retry after a timeout is safe).

type Body = { transactionId?: unknown; amount?: unknown; note?: unknown };

export async function POST(req: NextRequest) {
  const log = logger(req, "agent_api");
  const a = await authenticateMandate(req);
  if (!a.ok) return a.response;
  const body = await readJson<Body>(req);
  if (!body) return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  if (typeof body.transactionId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.transactionId)) return NextResponse.json({ error: "transactionId is required (the id returned by /authorize)." }, { status: 400 });
  if (body.amount !== undefined && (typeof body.amount !== "number" || !Number.isInteger(body.amount) || body.amount <= 0)) return NextResponse.json({ error: "amount, when given, must be a positive integer in minor units." }, { status: 400 });
  if (body.note !== undefined && typeof body.note !== "string") return NextResponse.json({ error: "note must be a string." }, { status: 400 });

  const r = await captureTransaction({ mandateId: a.mandate.id }, body.transactionId, { amount: body.amount as number | undefined, by: "agent", note: body.note as string | undefined });
  if (!r.ok) {
    const status = r.code === "not_found" ? 404 : r.code === "bad_amount" ? 400 : 409;
    log.info("capture.refused", { code: r.code, transactionId: body.transactionId });
    return NextResponse.json({ error: r.message, code: r.code, ...(r.transaction ? { state: settlementView(r.transaction) } : {}) }, { status, headers: { "x-request-id": log.id } });
  }
  const f = await factsFor(a.mandate).catch(() => null);
  log.info("capture", { transactionId: r.transaction.id, captured: r.transaction.amount, released: r.released });
  return NextResponse.json({
    ...settlementView(r.transaction),
    remaining: f ? { today: Math.max(0, a.mandate.dailyLimit - f.spentToday), total: Math.max(0, a.mandate.totalLimit - f.spentTotal), perTransaction: a.mandate.perTxnLimit, currency: a.mandate.currency } : undefined,
  }, { headers: { "x-request-id": log.id } });
}
