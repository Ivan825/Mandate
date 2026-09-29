import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { allEvents, verifyChain, canonical } from "./ledger";
import { isProduction } from "./env";
import { db, schema } from "./db";
import { workspaceLabel } from "./ws-label";

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
// The receipt key also signs vouchers (lib/vouchers.ts) and anchors (lib/anchors.ts).
export function signingKey(): KeyObject { return privateKey(); }
export function publicKeyPem(): string {
  return createPublicKey(privateKey()).export({ type: "spki", format: "pem" }).toString();
}
export function keyId(): string {
  return createHash("sha256").update(publicKeyPem()).digest("hex").slice(0, 16);
}

// Key rotation: the public halves of retired keys go in
// RECEIPT_PREVIOUS_PUBLIC_KEYS (PEM blocks, comma- or newline-separated, or
// base64 of the 32 raw bytes). Signatures made under them still verify; a
// signature under any other key never does.
export function knownPublicKeys(): { keyId: string; key: KeyObject; pem: string; current: boolean }[] {
  const current = createPublicKey(privateKey());
  const out = [{ keyId: keyId(), key: current, pem: publicKeyPem(), current: true }];
  const raw = process.env.RECEIPT_PREVIOUS_PUBLIC_KEYS?.trim();
  if (!raw) return out;
  const parts = raw.includes("-----BEGIN") ? raw.split(/-----END PUBLIC KEY-----/).map((p) => (p.trim() ? p.trim() + "\n-----END PUBLIC KEY-----\n" : "")).filter(Boolean) : raw.split(/[,\s]+/).filter(Boolean);
  for (const part of parts) {
    try {
      const key = part.startsWith("-----BEGIN") ? createPublicKey(part) : createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(part, "base64")]), format: "der", type: "spki" });
      if (key.asymmetricKeyType !== "ed25519") continue;
      const pem = key.export({ type: "spki", format: "pem" }).toString();
      const id = createHash("sha256").update(pem).digest("hex").slice(0, 16);
      if (!out.some((k) => k.keyId === id)) out.push({ keyId: id, key, pem, current: false });
    } catch { /* an unparseable entry is skipped, never trusted */ }
  }
  return out;
}
export function publicKeyFor(id: string): KeyObject | null { return knownPublicKeys().find((k) => k.keyId === id)?.key ?? null; }

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
    const key = publicKeyFor(typeof sig.keyId === "string" ? sig.keyId : keyId());
    if (!key) return false;
    return edVerify(null, Buffer.from(message), key, Buffer.from(sig.signature, "base64"));
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
  chain: { label: string; head: { seq: number; hash: string }; verified: boolean };
  // The first public anchor covering the last event in this receipt, when
  // one exists: independent evidence that the history was published by then.
  anchor?: { n: number; label: string; seq: number; hash: string; coversSeq: number; anchorHash: string; signedAt: string; url: string } | null;
  signature: { alg: "Ed25519"; keyId: string; publicKeyPem: string; signedAt: string; coreHash: string; message: string; signature: string };
};

function safeJson(s: string): unknown { try { return JSON.parse(s); } catch { return null; } }

// A public receipt names roles, not people: every email address becomes
// "a…@example.com", and account identifiers are dropped. The signature is
// made over the redacted core, so the redaction is part of what is signed.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function redactPerson(v: string): string {
  if (!EMAIL_RE.test(v)) return v;
  const [local, domain] = v.split("@");
  return `${local.slice(0, 1)}…@${domain}`;
}
function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 8) return value;
  if (typeof value === "string") return value.length < 320 && value.includes("@") ? value.split(/(\s+|\s\+\s)/).map((part) => redactPerson(part)).join("") : value;
  if (Array.isArray(value)) return value.map((x) => redactDeep(x, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "userId" || k === "authorId") continue;
      out[k] = redactDeep(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function txReceiptMessage(txId: string, coreHash: string, signedAt: string) { return `mandate-tx-receipt|${txId}|${coreHash}|${signedAt}`; }

export async function buildTransactionReceipt(txId: string, shareToken: string, issuer: string): Promise<TxReceipt | null> {
  const [t] = await db.select().from(schema.transactions).where(and(eq(schema.transactions.id, txId), eq(schema.transactions.shareToken, shareToken))).limit(1);
  if (!t) return null;
  const [m] = await db.select().from(schema.mandates).where(eq(schema.mandates.id, t.mandateId)).limit(1);
  const [ag] = m ? await db.select({ name: schema.agents.name }).from(schema.agents).where(eq(schema.agents.id, m.agentId)).limit(1) : [];
  const approval = t.approvalId ? (await db.select().from(schema.approvals).where(eq(schema.approvals.id, t.approvalId)).limit(1))[0] ?? null : null;
  const ids = [t.id, ...(t.approvalId ? [t.approvalId] : [])];
  const rows = await db.select().from(schema.ledger).where(and(eq(schema.ledger.workspaceId, t.workspaceId), sql`(${sql.join([sql`${schema.ledger.payload} like ${'%"transactionId":"' + t.id + '"%'}`, ...(t.approvalId ? [sql`${schema.ledger.payload} like ${'%"approvalId":"' + t.approvalId + '"%'}`] : [])], sql` or `)})`)).orderBy(asc(schema.ledger.seq));
  void ids;
  const verification = await verifyChain(t.workspaceId);
  const [head] = await db.select({ seq: schema.ledger.seq, hash: schema.ledger.hash }).from(schema.ledger).where(eq(schema.ledger.workspaceId, t.workspaceId)).orderBy(sql`${schema.ledger.seq} desc`).limit(1);
  const authorized = t.authorizedAmount ?? t.amount;
  const humanSig = approval?.signature ? (safeJson(approval.signature) as Record<string, unknown> | null) : null;
  if (humanSig) delete humanSig.userId;
  const core = {
    transaction: {
      id: t.id, createdAt: new Date(t.createdAt).toISOString(), decision: t.decision, reason: t.reason, source: t.source, actor: redactPerson(t.actor),
      amount: t.amount, authorizedAmount: authorized, currency: t.currency, merchant: t.merchant, category: t.category, purpose: t.purpose,
      settlement: t.settlement, settledAt: t.settledAt ? new Date(t.settledAt).toISOString() : null, settledBy: t.settledBy ? redactPerson(t.settledBy) : t.settledBy, settlementNote: t.settlementNote, holdExpiresAt: t.holdExpiresAt ? new Date(t.holdExpiresAt).toISOString() : null,
      flags: JSON.parse(t.flags || "[]"),
    },
    mandate: m ? { id: m.id, name: m.name, currency: m.currency, perTxnLimit: m.perTxnLimit, dailyLimit: m.dailyLimit, totalLimit: m.totalLimit, approvalAbove: m.approvalAbove, allowedMerchants: JSON.parse(m.allowedMerchants), blockedCategories: JSON.parse(m.blockedCategories), activeHours: [m.activeHoursStart, m.activeHoursEnd], timezone: m.timezone, issuedAt: new Date(m.createdAt).toISOString(), expiresAt: m.expiresAt ? new Date(m.expiresAt).toISOString() : null, status: m.status, tokenPrefix: m.tokenPrefix } : {},
    agent: { name: ag?.name ?? "Agent" },
    approval: approval ? { id: approval.id, kind: approval.kind, status: approval.status, requestedAt: new Date(approval.requestedAt).toISOString(), decidedAt: approval.decidedAt ? new Date(approval.decidedAt).toISOString() : null, decidedBy: approval.decidedBy ? approval.decidedBy.split(" + ").map(redactPerson).join(" + ") : approval.decidedBy, amount: approval.amount, merchant: approval.merchant, purpose: approval.purpose, humanSignature: humanSig } : null,
    // Event payloads are redacted the same way (emails in `by`, notes' authors);
    // the row hashes shown are the ledger's own, over the unredacted payload,
    // so a reader compares them with the workspace's chain, not with this JSON.
    events: rows.filter((r) => !r.type.startsWith("receipt.") && !r.type.startsWith("dispute.")).map((r) => ({ seq: r.seq, type: r.type, createdAt: new Date(r.createdAt).toISOString(), prevHash: r.prevHash, hash: r.hash, payload: redactDeep(JSON.parse(r.payload)) })),
    // The workspace is named by its public label (the same one the anchors use).
    chain: { label: workspaceLabel(t.workspaceId), head: head ?? { seq: 0, hash: "0".repeat(64) }, verified: verification.ok },
  };
  const signedAt = new Date().toISOString();
  const coreHash = createHash("sha256").update(canonical(core)).digest("hex");
  const message = txReceiptMessage(t.id, coreHash, signedAt);
  const signature = edSign(null, Buffer.from(message), privateKey()).toString("base64");
  let anchor: TxReceipt["anchor"] = null;
  try {
    const { anchorCovering } = await import("./anchors");
    // The anchor that covers the decision itself (its authorization rows);
    // sharing the receipt later adds rows that no anchor may cover yet.
    const decisionRows = rows.filter((r) => r.type.startsWith("authorization."));
    const upTo = (decisionRows.length ? decisionRows : rows).reduce((m, r) => Math.max(m, r.seq), 0);
    const a = upTo ? await anchorCovering(t.workspaceId, upTo) : null;
    if (a) anchor = { n: a.n, label: a.label, seq: a.seq, hash: a.hash, coversSeq: upTo, anchorHash: a.anchorHash, signedAt: new Date(a.signedAt).toISOString(), url: `${issuer}/anchors?label=${a.label}` };
  } catch { /* anchors are optional evidence */ }
  return { version: 1, kind: "mandate-transaction-receipt", issuedAt: signedAt, issuer, ...core, anchor, signature: { alg: "Ed25519", keyId: keyId(), publicKeyPem: publicKeyPem(), signedAt, coreHash, message, signature } };
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
