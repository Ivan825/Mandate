import { NextRequest, NextResponse } from "next/server";
import { getTransaction, settlementView } from "@/lib/service";
import { authenticateMandate } from "@/lib/agent-auth";

// GET /api/agent/transactions/:id — the current state of one authorisation
// under this mandate: held, captured, voided or released, and by whom.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const a = await authenticateMandate(req);
  if (!a.ok) return a.response;
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Not a transaction id." }, { status: 400 });
  const t = await getTransaction({ mandateId: a.mandate.id }, id);
  if (!t) return NextResponse.json({ error: "No such authorisation under this mandate." }, { status: 404 });
  return NextResponse.json({ ...settlementView(t), reason: t.reason, rule: undefined });
}
