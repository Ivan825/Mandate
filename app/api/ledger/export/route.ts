import { NextRequest, NextResponse } from "next/server";
import { getCtx } from "@/lib/session";
import { verifyChain, allEvents } from "@/lib/ledger";

// Receipt export: the workspace's full chain (or one mandate's slice of it)
// plus the verification result at export time. Anyone can re-run the hashes.
export async function GET(req: NextRequest) {
  const ctx = await getCtx();
  if (!ctx) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const raw = req.nextUrl.searchParams.get("mandate");
  const mandateId = raw && /^[0-9a-f-]{36}$/i.test(raw) ? raw : null;
  const rows = await allEvents(ctx.workspaceId);
  const filtered = mandateId ? rows.filter((r) => r.payload.includes(`"mandateId":"${mandateId}"`)) : rows;
  const verification = await verifyChain(ctx.workspaceId);
  const body = {
    exportedAt: new Date().toISOString(), workspaceId: ctx.workspaceId, scope: mandateId ? { mandateId } : { all: true }, verification,
    algorithm: "sha256(seq|type|createdAtMs|prevHash|canonicalPayload), chained per workspace",
    events: filtered.map((r) => ({ seq: r.seq, type: r.type, createdAt: new Date(r.createdAt).toISOString(), prevHash: r.prevHash, hash: r.hash, payload: JSON.parse(r.payload) })),
  };
  return new NextResponse(JSON.stringify(body, null, 2), {
    headers: { "content-type": "application/json", "content-disposition": `attachment; filename="mandate-receipt${mandateId ? "-" + mandateId.slice(0, 8) : ""}.json"` },
  });
}
