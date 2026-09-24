import { NextRequest, NextResponse } from "next/server";
import { voidTransaction, factsFor, settlementView } from "@/lib/service";
import { authenticateMandate, readJson } from "@/lib/agent-auth";
import { logger } from "@/lib/log";

// Nothing was paid: release the whole hold back to the limits.
//
//   POST /api/agent/void
//   Authorization: Bearer mnd_...
//   { "transactionId": "…", "reason": "checkout failed" }

type Body = { transactionId?: unknown; reason?: unknown };

export async function POST(req: NextRequest) {
  const log = logger(req, "agent_api");
  const a = await authenticateMandate(req);
  if (!a.ok) return a.response;
  const body = await readJson<Body>(req);
  if (!body) return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  if (typeof body.transactionId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.transactionId)) return NextResponse.json({ error: "transactionId is required (the id returned by /authorize)." }, { status: 400 });
  if (body.reason !== undefined && typeof body.reason !== "string") return NextResponse.json({ error: "reason must be a string." }, { status: 400 });

  const r = await voidTransaction({ mandateId: a.mandate.id }, body.transactionId, { by: "agent", reason: body.reason as string | undefined });
  if (!r.ok) {
    const status = r.code === "not_found" ? 404 : 409;
    return NextResponse.json({ error: r.message, code: r.code, ...(r.transaction ? { state: settlementView(r.transaction) } : {}) }, { status, headers: { "x-request-id": log.id } });
  }
  const f = await factsFor(a.mandate).catch(() => null);
  log.info("void", { transactionId: r.transaction.id, released: r.released });
  return NextResponse.json({
    ...settlementView(r.transaction),
    remaining: f ? { today: Math.max(0, a.mandate.dailyLimit - f.spentToday), total: Math.max(0, a.mandate.totalLimit - f.spentTotal), perTransaction: a.mandate.perTxnLimit, currency: a.mandate.currency } : undefined,
  }, { headers: { "x-request-id": log.id } });
}
