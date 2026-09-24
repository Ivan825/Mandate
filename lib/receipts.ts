import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { allEvents, verifyChain, canonical } from "./ledger";
import { isProduction } from "./env";
import { db, schema } from "./db";

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
  if (isProduction()) throw new Error("RECEIPT_SIGNING_KEY is required in production.");
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

// Verification never trusts anything inside the receipt except the head and
// the signature bytes: the message is rebuilt from the claimed fields and
// checked against THIS server's key, so a receipt cannot bring its own key.
export function verifySignature(sig: Signature, expectWorkspaceId?: string): boolean {
  try {
    if (!sig || sig.alg !== "Ed25519" || typeof sig.signature !== "string" || !sig.head) return false;
    if (expectWorkspaceId && sig.workspaceId !== expectWorkspaceId) return false;
    const message = `mandate-receipt|${sig.workspaceId}|${sig.head.seq}|${sig.head.hash}|${sig.signedAt}`;
    return edVerify(null, Buffer.from(message), createPublicKey(publicKeyPem()), Buffer.from(sig.signature, "base64"));
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

// ---------- One decision, shared publicly ----------
//
// A transaction receipt is everything about one decision that a third party
// might want: the request, the answer and the rule, the money lifecycle,
// the terms it was decided under, the human approval if there was one, and
// the ledger rows that recorded all of it with their hashes. The signature
// covers a hash of the canonical core, so the receipt verifies on its own
// (in the browser, with the public key) without trusting the page.

export type TxReceipt = {
  version: 1; kind: "mandate-transaction-receipt"; issuedAt: string; issuer: string;
  transaction: Record<string, unknown>; mandate: Record<string, unknown>; agent: { name: string }; approval: Record<string, unknown> | null;
  events: { seq: number; type: string; createdAt: string; prevHash: string; hash: string; payload: unknown }[];
  chain: { workspaceId: string; head: { seq: number; hash: string }; verified: boolean };
  signature: { alg: "Ed25519"; keyId: string; publicKeyPem: string; signedAt: string; coreHash: string; message: string; signature: string };
};

function safeJson(s: string): unknown { try { return JSON.parse(s); } catch { return null; } }

export function txReceiptMessage(txId: string, coreHash: string, signedAt: string) { return `mandate-tx-receipt|${txId}|${coreHash}|${signedAt}`; }

export async function buildTransactionReceipt(txId: string, shareToken: string, issuer: string): Promise<TxReceipt | null> {
  const [t] = await db.select().from(schema.transactions).where(and(eq(schema.transactions.id, txId), eq(schema.transactions.shareToken, shareToken))).limit(1);
  if (!t) return null;
  const [m] = await db.select().from(schema.mandates).where(eq(schema.mandates.id, t.mandateId)).limit(1);
  const [ag] = m ? await db.select({ name: schema.agents.name }).from(schema.agents).where(eq(schema.agents.id, m.agentId)).limit(1) : [];
  const approval = t.approvalId ? (await db.select().from(schema.approvals).where(eq(schema.approvals.id, t.approvalId)).limit(1))[0] ?? null : null;
  const ids = [t.id, ...(t.approvalId ? [t.approvalId] : [])];
  const rows = await db.select().from(schema.ledger).where(and(eq(schema.ledger.workspaceId, t.workspaceId), sql`(${sql.join(ids.map((id) => sql`${schema.ledger.payload} like ${"%\"" + id + "\"%"}`), sql` or `)})`)).orderBy(asc(schema.ledger.seq));
  const verification = await verifyChain(t.workspaceId);
  const [head] = await db.select({ seq: schema.ledger.seq, hash: schema.ledger.hash }).from(schema.ledger).where(eq(schema.ledger.workspaceId, t.workspaceId)).orderBy(sql`${schema.ledger.seq} desc`).limit(1);
  const authorized = t.authorizedAmount ?? t.amount;
  const core = {
    transaction: {
      id: t.id, createdAt: new Date(t.createdAt).toISOString(), decision: t.decision, reason: t.reason, source: t.source, actor: t.actor,
      amount: t.amount, authorizedAmount: authorized, currency: t.currency, merchant: t.merchant, category: t.category, purpose: t.purpose,
      settlement: t.settlement, settledAt: t.settledAt ? new Date(t.settledAt).toISOString() : null, settledBy: t.settledBy, settlementNote: t.settlementNote, holdExpiresAt: t.holdExpiresAt ? new Date(t.holdExpiresAt).toISOString() : null,
      flags: JSON.parse(t.flags || "[]"),
    },
    mandate: m ? { id: m.id, name: m.name, currency: m.currency, perTxnLimit: m.perTxnLimit, dailyLimit: m.dailyLimit, totalLimit: m.totalLimit, approvalAbove: m.approvalAbove, allowedMerchants: JSON.parse(m.allowedMerchants), blockedCategories: JSON.parse(m.blockedCategories), activeHours: [m.activeHoursStart, m.activeHoursEnd], timezone: m.timezone, issuedAt: new Date(m.createdAt).toISOString(), expiresAt: m.expiresAt ? new Date(m.expiresAt).toISOString() : null, status: m.status, tokenPrefix: m.tokenPrefix } : {},
    agent: { name: ag?.name ?? "Agent" },
    approval: approval ? { id: approval.id, kind: approval.kind, status: approval.status, requestedAt: new Date(approval.requestedAt).toISOString(), decidedAt: approval.decidedAt ? new Date(approval.decidedAt).toISOString() : null, decidedBy: approval.decidedBy, amount: approval.amount, merchant: approval.merchant, purpose: approval.purpose, humanSignature: approval.signature ? safeJson(approval.signature) : null } : null,
    events: rows.map((r) => ({ seq: r.seq, type: r.type, createdAt: new Date(r.createdAt).toISOString(), prevHash: r.prevHash, hash: r.hash, payload: JSON.parse(r.payload) })),
    chain: { workspaceId: t.workspaceId, head: head ?? { seq: 0, hash: "0".repeat(64) }, verified: verification.ok },
  };
  const signedAt = new Date().toISOString();
  const coreHash = createHash("sha256").update(canonical(core)).digest("hex");
  const message = txReceiptMessage(t.id, coreHash, signedAt);
  const signature = edSign(null, Buffer.from(message), privateKey()).toString("base64");
  return { version: 1, kind: "mandate-transaction-receipt", issuedAt: signedAt, issuer, ...core, signature: { alg: "Ed25519", keyId: keyId(), publicKeyPem: publicKeyPem(), signedAt, coreHash, message, signature } };
}

// Server-side check of a receipt someone pastes back: recompute the core
// hash from the receipt's own core fields and verify against OUR key.
export function verifyTransactionReceipt(r: TxReceipt): { coreOk: boolean; signatureValid: boolean; signedByThisServer: boolean } {
  try {
    const { transaction, mandate, agent, approval, events, chain } = r;
    const coreHash = createHash("sha256").update(canonical({ transaction, mandate, agent, approval, events, chain })).digest("hex");
    const coreOk = coreHash === r.signature.coreHash;
    const message = txReceiptMessage(String(transaction.id), r.signature.coreHash, r.signature.signedAt);
    const ok = message === r.signature.message && edVerify(null, Buffer.from(message), createPublicKey(publicKeyPem()), Buffer.from(r.signature.signature, "base64"));
    return { coreOk, signatureValid: ok, signedByThisServer: ok };
  } catch { return { coreOk: false, signatureValid: false, signedByThisServer: false }; }
}
