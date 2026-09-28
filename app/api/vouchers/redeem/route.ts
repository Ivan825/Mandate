import { NextRequest, NextResponse } from "next/server";
import { redeemVoucher } from "@/lib/vouchers";
import { settlementView } from "@/lib/service";
import { rateLimit, clientIp } from "@/lib/ratelimit";

// POST /api/vouchers/redeem  { voucher, amount?, merchant, reference? }
// The merchant captures the sale against the voucher: at most the amount the
// voucher authorises, once. Less than authorised gives the rest back to the
// agent's mandate. No account is needed — the voucher is the credential.
export async function POST(req: NextRequest) {
  if (!(await rateLimit(`ip:${clientIp(req)}:voucher-redeem`, 60)).ok) return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  let body: { voucher?: unknown; amount?: unknown; merchant?: unknown; reference?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Body must be JSON." }, { status: 400 }); }
  if (typeof body.voucher !== "string" || body.voucher.length > 4000) return NextResponse.json({ error: "voucher must be a string." }, { status: 400 });
  if (body.amount !== undefined && (typeof body.amount !== "number" || !Number.isInteger(body.amount) || body.amount <= 0)) return NextResponse.json({ error: "amount must be a positive integer in minor units." }, { status: 400 });
  const merchant = typeof body.merchant === "string" ? body.merchant : "";
  const reference = typeof body.reference === "string" ? body.reference : undefined;
  const r = await redeemVoucher(body.voucher, { amount: body.amount as number | undefined, merchant, reference });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ redeemed: true, ...settlementView(r.result.transaction), released: r.result.released, voucher: { tx: r.payload.tx, mandate: r.payload.mandate, merchant: r.payload.merchant } });
}
