import { NextRequest, NextResponse } from "next/server";
import { listAnchors, anchorView, verifyAnchors } from "@/lib/anchors";
import { publicKeyPem, keyId } from "@/lib/receipts";
import { rateLimit, clientIp } from "@/lib/ratelimit";

// GET /api/ledger/anchors[?label=<sha256>&before=<n>&limit=<n>]
// Public. The deployment's anchor chain, newest first: each line is a signed
// statement that a workspace's ledger stood at (seq, hash) at signedAt.
// Verify with the key at /.well-known/mandate-receipt-key:
//   anchorHash = sha256(n|label|seq|hash|prevAnchorHash|signedAt)
//   Ed25519.verify(key, "mandate-anchor|" + anchorHash, base64(signature))
export async function GET(req: NextRequest) {
  if (!(await rateLimit(`ip:${clientIp(req)}:anchors`, 120)).ok) return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  const q = req.nextUrl.searchParams;
  const label = q.get("label") ?? undefined;
  const before = Number(q.get("before")) || undefined;
  const limit = Number(q.get("limit")) || 100;
  let rows = await listAnchors({ limit: label ? 500 : limit, before });
  if (label) rows = rows.filter((a) => a.label === label).slice(0, limit);
  const verification = q.get("verify") === "1" ? await verifyAnchors() : undefined;
  return NextResponse.json({ keyId: keyId(), publicKeyPem: publicKeyPem(), algorithm: "anchorHash = sha256(n|label|seq|hash|prevAnchorHash|signedAt); signature = Ed25519(\"mandate-anchor|\" + anchorHash)", labelOf: "sha256(\"mandate-ws:\" + workspaceId)", verification, anchors: rows.map(anchorView) }, { headers: { "cache-control": "public, max-age=60" } });
}

