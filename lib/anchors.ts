import { createHash, createPublicKey, randomUUID, sign as edSign, verify as edVerify } from "node:crypto";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { db, schema } from "./db";
import { appendEvent, GENESIS } from "./ledger";
import { publicKeyFor, keyId, signingKey } from "./receipts";
import type { LedgerAnchor } from "./schema";

// Ledger anchoring. A hash chain proves a ledger was not edited *in the
// middle*; it cannot by itself prove the operator did not quietly rebuild
// the whole chain last night. Anchors close that gap: once a day (and on
// demand) the head of every workspace's chain is signed and appended to one
// public, deployment-wide anchor chain (/anchors). A workspace is named by
// the hash of its id, so the list reveals nothing about who owns what,
// while anyone holding a receipt can find the anchor that covers it and see
// that the head it was signed against was published at that time. Copy the
// daily anchor line somewhere you do not control (a git commit, a tweet,
// another company's log) and the deployment cannot rewrite history either.
//
//   anchorHash = sha256(n|label|seq|hash|prevAnchorHash|signedAt)
//   signature  = Ed25519("mandate-anchor|" + anchorHash)

export { workspaceLabel } from "./ws-label";
import { workspaceLabel } from "./ws-label";

export function anchorHashOf(a: { n: number; label: string; seq: number; hash: string; prevAnchorHash: string; signedAt: Date | string }): string {
  const at = typeof a.signedAt === "string" ? a.signedAt : a.signedAt.toISOString();
  return createHash("sha256").update(`${a.n}|${a.label}|${a.seq}|${a.hash}|${a.prevAnchorHash}|${at}`).digest("hex");
}

export function verifyAnchorSignature(a: { anchorHash: string; signature: string; keyId?: string }): boolean {
  try {
    const key = publicKeyFor(a.keyId ?? keyId());
    if (!key) return false;
    return edVerify(null, Buffer.from("mandate-anchor|" + a.anchorHash), key, Buffer.from(a.signature, "base64"));
  } catch { return false; }
}

// Anchor one workspace's current head, unless the last anchor already covers it.
export async function anchorWorkspace(workspaceId: string): Promise<LedgerAnchor | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('mandate:anchors'))`);
    const [head] = await tx.select({ seq: schema.ledger.seq, hash: schema.ledger.hash }).from(schema.ledger).where(eq(schema.ledger.workspaceId, workspaceId)).orderBy(desc(schema.ledger.seq)).limit(1);
    if (!head) return null;
    const [mine] = await tx.select().from(schema.ledgerAnchors).where(eq(schema.ledgerAnchors.workspaceId, workspaceId)).orderBy(desc(schema.ledgerAnchors.n)).limit(1);
    if (mine && mine.seq === head.seq && mine.hash === head.hash) return null;
    // The anchor's own ledger entry moves the head; that alone is not news
    // worth another anchor, or every daily run would anchor twice forever.
    if (mine) {
      const [moved] = await tx.select({ c: sql<number>`count(*)::int` }).from(schema.ledger).where(and(eq(schema.ledger.workspaceId, workspaceId), sql`${schema.ledger.seq} > ${mine.seq}`, sql`${schema.ledger.type} <> 'ledger.anchored'`));
      if (Number(moved?.c ?? 0) === 0) return null;
    }
    const [last] = await tx.select().from(schema.ledgerAnchors).orderBy(desc(schema.ledgerAnchors.n)).limit(1);
    const signedAt = new Date(); signedAt.setUTCMilliseconds(0);
    const row: LedgerAnchor = { id: randomUUID(), workspaceId, label: workspaceLabel(workspaceId), seq: head.seq, hash: head.hash, prevAnchorHash: last?.anchorHash ?? GENESIS, anchorHash: "", signature: "", keyId: keyId(), signedAt, n: (last?.n ?? 0) + 1 };
    row.anchorHash = anchorHashOf(row);
    row.signature = edSign(null, Buffer.from("mandate-anchor|" + row.anchorHash), signingKey()).toString("base64");
    await tx.insert(schema.ledgerAnchors).values(row);
    // Recorded in the workspace's own ledger too, so the owner's feed shows
    // "anchored publicly at #N" and event webhooks carry it out.
    await appendEvent(tx, workspaceId, "ledger.anchored", { anchorId: row.id, n: row.n, seq: row.seq, hash: row.hash, anchorHash: row.anchorHash, signedAt: signedAt.toISOString(), label: row.label });
    return row;
  });
}

// Every workspace whose chain moved since its last anchor.
export async function anchorAll(limit = 500): Promise<number> {
  const heads = await db.execute(sql`select l.workspace_id as ws from ledger l where l.type <> 'ledger.anchored' group by l.workspace_id
    having max(l.seq) > coalesce((select a.seq from ledger_anchors a where a.workspace_id = l.workspace_id order by a.n desc limit 1), 0) limit ${limit}`);
  let n = 0;
  for (const r of heads.rows as { ws: string }[]) { try { if (await anchorWorkspace(r.ws)) n++; } catch (e) { console.error(`anchor ${r.ws}: ${(e as Error).message}`); } }
  return n;
}

// Called from the health ping: anchors everything once a day even on a host
// with no scheduler of its own.
export async function anchorIfDue(maxAgeMs = 24 * 3600_000): Promise<number> {
  const [last] = await db.select({ at: schema.ledgerAnchors.signedAt }).from(schema.ledgerAnchors).orderBy(desc(schema.ledgerAnchors.n)).limit(1);
  if (last && Date.now() - new Date(last.at).getTime() < maxAgeMs) return 0;
  return anchorAll();
}

export async function listAnchors(opts: { limit?: number; workspaceId?: string; label?: string; before?: number } = {}): Promise<LedgerAnchor[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const label = opts.label && /^[0-9a-f]{64}$/.test(opts.label) ? opts.label : opts.label ? "-" : undefined;
  return db.select().from(schema.ledgerAnchors).where(and(opts.workspaceId ? eq(schema.ledgerAnchors.workspaceId, opts.workspaceId) : undefined, label ? eq(schema.ledgerAnchors.label, label) : undefined, opts.before ? sql`${schema.ledgerAnchors.n} < ${opts.before}` : undefined)).orderBy(desc(schema.ledgerAnchors.n)).limit(limit);
}

export async function latestAnchor(workspaceId: string): Promise<LedgerAnchor | null> {
  const [a] = await db.select().from(schema.ledgerAnchors).where(eq(schema.ledgerAnchors.workspaceId, workspaceId)).orderBy(desc(schema.ledgerAnchors.n)).limit(1);
  return a ?? null;
}

// The first public anchor that covers a given ledger row: proof the row
// existed, with that hash, no later than the anchor's signedAt.
export async function anchorCovering(workspaceId: string, seq: number): Promise<LedgerAnchor | null> {
  const [a] = await db.select().from(schema.ledgerAnchors).where(and(eq(schema.ledgerAnchors.workspaceId, workspaceId), gte(schema.ledgerAnchors.seq, seq))).orderBy(asc(schema.ledgerAnchors.n)).limit(1);
  return a ?? null;
}

// Re-check the global anchor chain: every hash and link, and every signature.
// A signature must verify under the current key or one of the retired keys
// listed in RECEIPT_PREVIOUS_PUBLIC_KEYS; an anchor under any other key is a
// break. `otherKey` counts anchors verified under a retired key.
export type AnchorVerification = { ok: boolean; checked: number; otherKey: number; brokenAt?: number; detail?: string };
export async function verifyAnchors(): Promise<AnchorVerification> {
  const rows = await db.select().from(schema.ledgerAnchors).orderBy(asc(schema.ledgerAnchors.n));
  const current = keyId();
  let prev = GENESIS;
  let otherKey = 0;
  for (const a of rows) {
    if (a.prevAnchorHash !== prev) return { ok: false, checked: a.n - 1, otherKey, brokenAt: a.n, detail: "Previous-anchor link does not match" };
    if (anchorHashOf(a) !== a.anchorHash) return { ok: false, checked: a.n - 1, otherKey, brokenAt: a.n, detail: "Anchor content does not match its hash" };
    if (!verifyAnchorSignature(a)) return { ok: false, checked: a.n - 1, otherKey, brokenAt: a.n, detail: a.keyId === current || publicKeyFor(a.keyId) ? "Signature does not verify" : `Signed with an unknown key ${a.keyId}` };
    if (a.keyId !== current) otherKey++;
    prev = a.anchorHash;
  }
  return { ok: true, checked: rows.length, otherKey };
}

// The public pages call this on every view; the full walk is cached for a
// minute per process so a crowd of anonymous readers cannot make the database
// re-verify the whole chain for each of them.
let verifyCache: { at: number; value: Promise<AnchorVerification> } | null = null;
export function verifyAnchorsCached(maxAgeMs = 60_000): Promise<AnchorVerification> {
  if (verifyCache && Date.now() - verifyCache.at < maxAgeMs) return verifyCache.value;
  const value = verifyAnchors().catch((e) => { verifyCache = null; throw e; });
  verifyCache = { at: Date.now(), value };
  return value;
}

export function anchorView(a: LedgerAnchor) {
  return { n: a.n, label: a.label, seq: a.seq, hash: a.hash, prevAnchorHash: a.prevAnchorHash, anchorHash: a.anchorHash, signature: a.signature, keyId: a.keyId, signedAt: new Date(a.signedAt).toISOString(), line: `${a.n} ${a.label.slice(0, 16)} #${a.seq} ${a.hash} ${a.anchorHash} ${new Date(a.signedAt).toISOString()}` };
}
