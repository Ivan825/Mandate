import { NextRequest, NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { verifyChain } from "@/lib/ledger";

// Signed receipt export: the full chain (or one mandate's slice of it) plus
// the verification result at export time. Hand this to a merchant, issuer or
// auditor; anyone can re-run the hashes.
export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("mandate");
  const mandateId = raw && /^[0-9a-f-]{36}$/i.test(raw) ? raw : null;
  const rows = await db.select().from(schema.ledger).orderBy(asc(schema.ledger.seq));
  const filtered = mandateId ? rows.filter((r) => r.payload.includes(`"mandateId":"${mandateId}"`)) : rows;
  const verification = await verifyChain();
  const body = {
    exportedAt: new Date().toISOString(),
    scope: mandateId ? { mandateId } : { all: true },
    verification,
    algorithm: "sha256(seq|type|createdAtMs|prevHash|canonicalPayload)",
    events: filtered.map((r) => ({ seq: r.seq, type: r.type, createdAt: new Date(r.createdAt).toISOString(), prevHash: r.prevHash, hash: r.hash, payload: JSON.parse(r.payload) })),
  };
  return new NextResponse(JSON.stringify(body, null, 2), {
    headers: { "content-type": "application/json", "content-disposition": `attachment; filename="mandate-receipt${mandateId ? "-" + mandateId.slice(0, 8) : ""}.json"` },
  });
}
