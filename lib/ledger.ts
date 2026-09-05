import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db, schema, type Tx } from "./db";

export const GENESIS = "0".repeat(64);

// Deterministic JSON: sorted keys, no whitespace. Two processes hashing the
// same event must produce the same bytes.
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const obj = value as Record<string, unknown>;
  return "{" + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") + "}";
}

export function hashEvent(seq: number, type: string, payload: string, prevHash: string, createdAtMs: number): string {
  return createHash("sha256").update(`${seq}|${type}|${createdAtMs}|${prevHash}|${payload}`).digest("hex");
}

// One chain per workspace. The append runs inside the caller's transaction
// so the business write and its ledger entry commit together; an advisory
// lock on the workspace serialises appends, so seq never collides.
export async function appendEvent(tx: Tx, workspaceId: string, type: string, payload: Record<string, unknown>) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"ledger:" + workspaceId}))`);
  const [last] = await tx.select({ seq: schema.ledger.seq, hash: schema.ledger.hash }).from(schema.ledger)
    .where(eq(schema.ledger.workspaceId, workspaceId)).orderBy(desc(schema.ledger.seq)).limit(1);
  const seq = (last?.seq ?? 0) + 1;
  const prevHash = last?.hash ?? GENESIS;
  const createdAt = new Date();
  const body = canonical(payload);
  const hash = hashEvent(seq, type, body, prevHash, createdAt.getTime());
  await tx.insert(schema.ledger).values({ id: randomUUID(), workspaceId, seq, type, payload: body, prevHash, hash, createdAt });
  return { seq, hash };
}

// Convenience for events that have no surrounding transaction.
export async function recordEvent(workspaceId: string, type: string, payload: Record<string, unknown>) {
  return db.transaction((tx) => appendEvent(tx, workspaceId, type, payload));
}

export async function verifyChain(workspaceId: string): Promise<{ ok: boolean; checked: number; brokenAt?: number; detail?: string }> {
  const rows = await db.select().from(schema.ledger).where(eq(schema.ledger.workspaceId, workspaceId)).orderBy(asc(schema.ledger.seq));
  let prev = GENESIS;
  let expectedSeq = 1;
  for (const r of rows) {
    if (r.seq !== expectedSeq) return { ok: false, checked: expectedSeq - 1, brokenAt: r.seq, detail: `Sequence gap: expected ${expectedSeq}, found ${r.seq}` };
    if (r.prevHash !== prev) return { ok: false, checked: r.seq - 1, brokenAt: r.seq, detail: "Previous-hash link does not match" };
    const h = hashEvent(r.seq, r.type, r.payload, r.prevHash, new Date(r.createdAt).getTime());
    if (h !== r.hash) return { ok: false, checked: r.seq - 1, brokenAt: r.seq, detail: "Row content does not match its hash" };
    prev = r.hash;
    expectedSeq++;
  }
  return { ok: true, checked: rows.length };
}

export async function listEvents(workspaceId: string, limit = 100) {
  return db.select().from(schema.ledger).where(eq(schema.ledger.workspaceId, workspaceId)).orderBy(desc(schema.ledger.seq)).limit(limit);
}

export async function allEvents(workspaceId: string) {
  return db.select().from(schema.ledger).where(and(eq(schema.ledger.workspaceId, workspaceId))).orderBy(asc(schema.ledger.seq));
}
