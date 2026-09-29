import { NextResponse } from "next/server";
import { publicKeyPem, keyId, knownPublicKeys } from "@/lib/receipts";

// The current signing key as PEM. Retired keys (after a rotation) are listed
// in the X-Previous-Key-Ids header and served in full at ?all=1 as JSON.
export async function GET(req: Request) {
  const all = new URL(req.url).searchParams.get("all") === "1";
  const keys = knownPublicKeys();
  if (all) return NextResponse.json({ current: keyId(), keys: keys.map((k) => ({ keyId: k.keyId, publicKeyPem: k.pem, current: k.current })) }, { headers: { "cache-control": "public, max-age=300" } });
  const previous = keys.filter((k) => !k.current).map((k) => k.keyId).join(", ");
  return new NextResponse(publicKeyPem(), { headers: { "content-type": "application/x-pem-file", "x-key-id": keyId(), ...(previous ? { "x-previous-key-ids": previous } : {}), "cache-control": "public, max-age=300" } });
}
