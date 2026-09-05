import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import { allEvents, verifyChain } from "./ledger";

// A receipt is the workspace's ledger (or one mandate's slice) plus a
// signature over the chain head. The signing key lives outside the database
// (RECEIPT_SIGNING_KEY: 32-byte Ed25519 seed, base64), so an operator with
// database access can rewrite history but cannot re-sign it. Anyone can
// verify with the public key served at /.well-known/mandate-receipt-key.

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function seed(): Buffer {
  const raw = process.env.RECEIPT_SIGNING_KEY;
  if (raw) {
    const b = Buffer.from(raw, "base64");
    if (b.length === 32) return b;
    throw new Error("RECEIPT_SIGNING_KEY must be a 32-byte seed, base64-encoded (openssl rand -base64 32).");
  }
  if (process.env.VERCEL) throw new Error("RECEIPT_SIGNING_KEY is required in production.");
  return createHash("sha256").update("mandate-receipt:" + (process.env.BETTER_AUTH_SECRET ?? "dev")).digest();
}

let priv: KeyObject | null = null;
function privateKey(): KeyObject {
  if (!priv) priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed()]), format: "der", type: "pkcs8" });
  return priv;
}
export function publicKeyPem(): string {
  return createPublicKey(privateKey()).export({ type: "spki", format: "pem" }).toString();
}
export function keyId(): string {
  return createHash("sha256").update(publicKeyPem()).digest("hex").slice(0, 16);
}

export type Signature = { alg: "Ed25519"; keyId: string; publicKeyPem: string; signedAt: string; head: { seq: number; hash: string }; workspaceId: string; signature: string; message: string };

export function signHead(workspaceId: string, head: { seq: number; hash: string }): Signature {
  const signedAt = new Date().toISOString();
  const message = `mandate-receipt|${workspaceId}|${head.seq}|${head.hash}|${signedAt}`;
  const signature = edSign(null, Buffer.from(message), privateKey()).toString("base64");
  return { alg: "Ed25519", keyId: keyId(), publicKeyPem: publicKeyPem(), signedAt, head, workspaceId, signature, message };
}

export function verifySignature(sig: Signature): boolean {
  try {
    return edVerify(null, Buffer.from(sig.message), createPublicKey(sig.publicKeyPem), Buffer.from(sig.signature, "base64"));
  } catch { return false; }
}

export async function buildReceipt(workspaceId: string, mandateId: string | null) {
  const rows = await allEvents(workspaceId);
  const verification = await verifyChain(workspaceId, true);
  const head = rows.length ? { seq: rows[rows.length - 1].seq, hash: rows[rows.length - 1].hash } : { seq: 0, hash: "0".repeat(64) };
  const filtered = mandateId ? rows.filter((r) => r.payload.includes(`"mandateId":"${mandateId}"`)) : rows;
  return {
    exportedAt: new Date().toISOString(), workspaceId, scope: mandateId ? { mandateId } : { all: true }, verification,
    algorithm: "sha256(seq|type|createdAtMs|prevHash|canonicalPayload), chained per workspace; head signed with Ed25519",
    signature: verification.ok ? signHead(workspaceId, head) : null,
    note: mandateId ? "A mandate-scoped receipt lists that mandate's events; the signature covers the whole workspace chain head at export time, so the full chain (all: true) is what an auditor re-verifies." : undefined,
    events: filtered.map((r) => ({ seq: r.seq, type: r.type, createdAt: new Date(r.createdAt).toISOString(), prevHash: r.prevHash, hash: r.hash, payload: JSON.parse(r.payload) })),
  };
}
