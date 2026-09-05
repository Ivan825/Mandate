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
  let r: { events?: { seq: number; type: string; createdAt: string; prevHash: string; hash: string; payload: unknown }[]; signature?: Signature | null; scope?: { all?: boolean } };
  try { r = await req.json(); } catch { return NextResponse.json({ error: "Body must be a receipt JSON." }, { status: 400 }); }
  const events = r.events ?? [];
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
  const sigOk = r.signature ? verifySignature(r.signature) : false;
  const ours = r.signature ? r.signature.keyId === keyId() : false;
  return NextResponse.json({ chainOk, detail: detail || undefined, signatureValid: sigOk, signedByThisServer: ours, events: events.length });
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const obj = value as Record<string, unknown>;
  return "{" + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") + "}";
}
