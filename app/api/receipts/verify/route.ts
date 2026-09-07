import { NextRequest, NextResponse } from "next/server";
import { hashEvent, GENESIS } from "@/lib/ledger";
import { verifySignature, publicKeyPem, keyId, type Signature } from "@/lib/receipts";

// Public verifier: POST an exported receipt and get back whether its chain
// re-hashes cleanly and whether the head signature is ours. Anyone can call
// this — a merchant, an issuer, an auditor — without an account.
export async function GET() {
  return NextResponse.json({ keyId: keyId(), publicKeyPem: publicKeyPem(), how: "POST the receipt JSON here, or verify offline: Ed25519 over `message` with this public key; re-hash events with sha256(seq|type|createdAtMs|prevHash|canonicalPayload)." });
}

export async function POST(req: NextRequest) {
  let r: { workspaceId?: string; events?: { seq: number; type: string; createdAt: string; prevHash: string; hash: string; payload: unknown }[]; signature?: Signature | null; scope?: { all?: boolean } };
  try { r = await req.json(); } catch { return NextResponse.json({ error: "Body must be a receipt JSON." }, { status: 400 }); }
  const events = Array.isArray(r.events) ? r.events : [];
  if (events.length > 50_000) return NextResponse.json({ error: "Receipt too large to verify online; verify offline with the public key." }, { status: 413 });
  let chainOk = true, detail = "";
  if (r.scope?.all) {
    let prev = GENESIS, expected = 1;
    for (const e of events) {
      const canon = canonical(e.payload);
      if (e.seq !== expected || e.prevHash !== prev || hashEvent(e.seq, e.type, canon, e.prevHash, new Date(e.createdAt).getTime()) !== e.hash) { chainOk = false; detail = `Chain breaks at #${e.seq}.`; break; }
      prev = e.hash; expected++;
    }
    if (chainOk && r.signature && events.length) {
      const last = events[events.length - 1];
      if (r.signature.head.seq !== last.seq || r.signature.head.hash !== last.hash) { chainOk = false; detail = "Signed head does not match the last event."; }
    }
  } else {
    // A mandate slice can only be checked row-by-row (each row's own hash), not as a chain.
    for (const e of events) if (hashEvent(e.seq, e.type, canonical(e.payload), e.prevHash, new Date(e.createdAt).getTime()) !== e.hash) { chainOk = false; detail = `Row #${e.seq} does not match its hash.`; break; }
  }
  // The signature is checked against this server's own key, over a message
  // rebuilt from the head; nothing embedded in the receipt is trusted.
  const sigOk = r.signature ? verifySignature(r.signature, typeof r.workspaceId === "string" ? r.workspaceId : undefined) : false;
  const full = r.scope?.all === true;
  return NextResponse.json({
    chainOk, detail: detail || undefined, signatureValid: sigOk, signedByThisServer: sigOk, keyId: keyId(), events: events.length,
    // Only a full-workspace receipt has its rows covered by the signature; a
    // mandate slice proves each row's own hash but not that the slice is
    // complete or unaltered — say so, rather than leave "chainOk" to imply it.
    coverage: full ? "chain" : "rows-only",
    eventsCovered: full && chainOk && sigOk,
    note: full ? undefined : "This is a mandate-scoped slice. The signature covers the workspace chain head at export time, not these rows; verify the full receipt (scope.all) for a covered verdict.",
  });
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const obj = value as Record<string, unknown>;
  return "{" + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") + "}";
}
