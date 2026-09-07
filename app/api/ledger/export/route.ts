import { NextRequest, NextResponse } from "next/server";
import { getCtx, can } from "@/lib/session";
import { buildReceipt } from "@/lib/receipts";

// Receipt export: the workspace's chain (or one mandate's slice) with the
// verification result and an Ed25519 signature over the chain head.
export async function GET(req: NextRequest) {
  const ctx = await getCtx();
  if (!ctx) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!(await can({ ledger: ["export"] }))) return NextResponse.json({ error: "Your role cannot export the ledger." }, { status: 403 });
  const raw = req.nextUrl.searchParams.get("mandate");
  const mandateId = raw && /^[0-9a-f-]{36}$/i.test(raw) ? raw : null;
  const body = await buildReceipt(ctx.workspaceId, mandateId);
  return new NextResponse(JSON.stringify(body, null, 2), {
    headers: { "content-type": "application/json", "content-disposition": `attachment; filename="mandate-receipt${mandateId ? "-" + mandateId.slice(0, 8) : ""}.json"` },
  });
}
