import { NextRequest, NextResponse } from "next/server";
import { buildTransactionReceipt, verifyTransactionReceipt, type TxReceipt } from "@/lib/receipts";
import { appUrl } from "@/lib/env";
import { rateLimit, clientIp } from "@/lib/ratelimit";

// GET  /api/receipts/tx/:id?k=<share token>  — the signed receipt for one shared decision
// POST /api/receipts/tx/:id                    — verify a receipt JSON someone hands you (no token needed)
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!(await rateLimit(`ip:${clientIp(req)}:receipt`, 120)).ok) return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  const { id } = await ctx.params;
  const k = (req.nextUrl.searchParams.get("k") ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[A-Za-z0-9_-]{16,64}$/.test(k)) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const r = await buildTransactionReceipt(id, k, appUrl());
  if (!r) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json(r, { headers: { "cache-control": "no-store", "content-disposition": `inline; filename="mandate-receipt-${id.slice(0, 8)}.json"` } });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!(await rateLimit(`ip:${clientIp(req)}:receipt-verify`, 60)).ok) return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  const { id } = await ctx.params;
  let r: TxReceipt;
  try { r = await req.json(); } catch { return NextResponse.json({ error: "Body must be a receipt JSON." }, { status: 400 }); }
  if (!r || r.kind !== "mandate-transaction-receipt" || String(r.transaction?.id) !== id) return NextResponse.json({ error: "Not a transaction receipt for this id." }, { status: 400 });
  const base = verifyTransactionReceipt(r);
  const hs = (r.approval as { humanSignature?: unknown } | null)?.humanSignature;
  let humanSignatureValid: boolean | null = null;
  if (hs && typeof hs === "object") { const { recheckHumanSignature } = await import("@/lib/human-sign"); humanSignatureValid = await recheckHumanSignature(hs as Parameters<typeof recheckHumanSignature>[0]); }
  return NextResponse.json({ ...base, humanSignatureValid });
}
