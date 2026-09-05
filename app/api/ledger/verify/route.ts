import { NextResponse } from "next/server";
import { getCtx } from "@/lib/session";
import { verifyChain } from "@/lib/ledger";
export async function GET() {
  const ctx = await getCtx();
  if (!ctx) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  return NextResponse.json(await verifyChain(ctx.workspaceId));
}
