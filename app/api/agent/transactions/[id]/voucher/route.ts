import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { getTransaction } from "@/lib/service";
import { issueAndRecordVoucher, verifyVoucher } from "@/lib/vouchers";
import { authenticateMandate } from "@/lib/agent-auth";
import { appUrl } from "@/lib/env";

// GET /api/agent/transactions/:id/voucher — the signed authorisation voucher
// for an approved decision, to hand to the merchant. Re-issuable while the
// hold is open; the merchant redeems it once at POST /api/vouchers/redeem.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const a = await authenticateMandate(req);
  if (!a.ok) return a.response;
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Not a transaction id." }, { status: 400 });
  const t = await getTransaction({ mandateId: a.mandate.id }, id);
  if (!t) return NextResponse.json({ error: "No such authorisation under this mandate." }, { status: 404 });
  if (t.decision !== "approved") return NextResponse.json({ error: `This decision was ${t.decision}; there is nothing to present.` }, { status: 409 });
  if (t.settlement !== "held") return NextResponse.json({ error: `This authorisation is already ${t.settlement}; a voucher can only be issued while the hold is open.` }, { status: 409 });
  const [ag] = await db.select({ name: schema.agents.name }).from(schema.agents).where(eq(schema.agents.id, a.mandate.agentId)).limit(1);
  const voucher = await issueAndRecordVoucher(t, a.mandate, ag?.name ?? "Agent", appUrl());
  if (!voucher) return NextResponse.json({ error: "Could not issue a voucher for this decision." }, { status: 409 });
  const v = verifyVoucher(voucher);
  return NextResponse.json({ voucher, payload: v.payload, expiresAt: v.payload?.expiresAt, verifyUrl: `${appUrl()}/api/vouchers/verify`, redeemUrl: `${appUrl()}/api/vouchers/redeem`, publicKeyUrl: `${appUrl()}/.well-known/mandate-receipt-key`, next: "Present the voucher to the merchant. They verify it offline with the public key (or at verifyUrl) and redeem it at redeemUrl for the amount actually sold. This hold is now theirs to settle: you can no longer capture or void it; unredeemed, it closes by the mandate's policy at expiresAt." }, { headers: { "cache-control": "no-store" } });
}
