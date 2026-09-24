import { NextRequest, NextResponse } from "next/server";
import { getPlan, planView } from "@/lib/service";
import { authenticateMandate } from "@/lib/agent-auth";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const a = await authenticateMandate(req);
  if (!a.ok) return a.response;
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Not a plan id." }, { status: 400 });
  const p = await getPlan({ mandateId: a.mandate.id }, id);
  if (!p) return NextResponse.json({ error: "No such plan under this mandate." }, { status: 404 });
  return NextResponse.json(planView(p));
}
