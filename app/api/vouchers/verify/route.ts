import { NextRequest, NextResponse } from "next/server";
import { voucherStatus } from "@/lib/vouchers";
import { rateLimit, clientIp } from "@/lib/ratelimit";

// POST /api/vouchers/verify  { voucher: "mv1.…" }
// Public. A merchant (or anyone handed a voucher) checks the signature and
// asks what has become of the decision: still redeemable, already captured,
// voided, mandate revoked, workspace frozen. The offline check needs only
// the public key at /.well-known/mandate-receipt-key:
//   Ed25519.verify(key, "mandate-voucher|" + base64urlDecode(payload), signature)
export async function POST(req: NextRequest) {
  if (!(await rateLimit(`ip:${clientIp(req)}:voucher`, 120)).ok) return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  let body: { voucher?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Body must be JSON with a voucher field." }, { status: 400 }); }
  if (typeof body.voucher !== "string" || body.voucher.length > 4000) return NextResponse.json({ error: "voucher must be a string." }, { status: 400 });
  const st = await voucherStatus(body.voucher);
  return NextResponse.json({ valid: st.valid, redeemable: st.redeemable, expired: st.expired ?? false, error: st.error ?? null, settlement: st.settlement, capturedAmount: st.capturedAmount, mandateStatus: st.mandateStatus, workspaceFrozen: st.workspaceFrozen, voucher: st.payload }, { headers: { "cache-control": "no-store" } });
}
