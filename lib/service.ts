import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db, schema, type Conn } from "./db";
import { appendEvent } from "./ledger";
import { evaluate, localDayStart, validateTerms, ALLOWANCE_TTL_MS, DENIAL_COOLOFF_MS, type AuthRequest, type Decision, type TermsError } from "./policy";
import type { Mandate, Approval, Transaction } from "./schema";

const { agents, mandates, transactions, approvals } = schema;

export function newToken(): string {
  return "mnd_" + randomBytes(24).toString("base64url");
}
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// ---------- Agents ----------

export async function createAgent(input: { name: string; description?: string }) {
  const row = { id: randomUUID(), name: input.name.trim().slice(0, 80), description: (input.description ?? "").trim().slice(0, 500), createdAt: new Date() };
  await db.transaction(async (tx) => {
    await tx.insert(agents).values(row);
    await appendEvent("agent.created", { agentId: row.id, name: row.name }, tx);
  }, { behavior: "immediate" });
  return row;
}

export async function listAgents() {
  return db.select().from(agents).orderBy(desc(agents.createdAt));
}

// ---------- Mandates ----------

export type MandateInput = {
  agentId: string;
  name: string;
  currency: string;
  perTxnLimit: number;
  dailyLimit: number;
  totalLimit: number;
  approvalAbove: number | null;
  allowedMerchants: string[];
  blockedCategories: string[];
  activeHoursStart: number;
  activeHoursEnd: number;
  timezone: string;
  expiresAt: Date | null;
};

export type CreateResult = { ok: true; mandate: Mandate; token: string } | { ok: false; errors: TermsError[] };

export async function createMandate(input: MandateInput): Promise<CreateResult> {
  const currency = input.currency.toUpperCase();
  const errors = validateTerms({ ...input, currency });
  if (errors.length) return { ok: false, errors };
  const token = newToken();
  const row: Mandate = {
    id: randomUUID(),
    agentId: input.agentId,
    name: input.name.trim().slice(0, 80),
    status: "active",
    currency,
    perTxnLimit: input.perTxnLimit,
    dailyLimit: input.dailyLimit,
    totalLimit: input.totalLimit,
    approvalAbove: input.approvalAbove,
    allowedMerchants: JSON.stringify(input.allowedMerchants.map((s) => s.trim().slice(0, 80)).filter(Boolean).slice(0, 50)),
    blockedCategories: JSON.stringify(input.blockedCategories.map((s) => s.trim().slice(0, 64)).filter(Boolean).slice(0, 50)),
    activeHoursStart: input.activeHoursStart,
    activeHoursEnd: input.activeHoursEnd,
    timezone: input.timezone,
    expiresAt: input.expiresAt,
    tokenHash: hashToken(token),
    tokenPrefix: token.slice(0, 10),
    tokenReveal: token,
    stripeCardholderId: null,
    stripeCardId: null,
    cardLast4: null,
    cardError: null,
    createdAt: new Date(),
    revokedAt: null,
  };
  await db.transaction(async (tx) => {
    await tx.insert(mandates).values(row);
    await appendEvent("mandate.issued", {
      mandateId: row.id, agentId: row.agentId, name: row.name, currency: row.currency,
      perTxnLimit: row.perTxnLimit, dailyLimit: row.dailyLimit, totalLimit: row.totalLimit,
      approvalAbove: row.approvalAbove, allowedMerchants: JSON.parse(row.allowedMerchants),
      blockedCategories: JSON.parse(row.blockedCategories),
      activeHours: [row.activeHoursStart, row.activeHoursEnd], timezone: row.timezone,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null, tokenPrefix: row.tokenPrefix,
    }, tx);
  }, { behavior: "immediate" });
  return { ok: true, mandate: row, token };
}

// Returns the plaintext token once, then forgets it.
export async function takeTokenReveal(mandateId: string): Promise<string | null> {
  const [m] = await db.select({ t: mandates.tokenReveal }).from(mandates).where(eq(mandates.id, mandateId)).limit(1);
  if (!m?.t) return null;
  await db.update(mandates).set({ tokenReveal: null }).where(eq(mandates.id, mandateId));
  return m.t;
}

export async function attachCard(mandateId: string, card: { cardholderId: string; cardId: string; last4: string }) {
  await db.transaction(async (tx) => {
    await tx.update(mandates).set({ stripeCardholderId: card.cardholderId, stripeCardId: card.cardId, cardLast4: card.last4, cardError: null }).where(eq(mandates.id, mandateId));
    await appendEvent("mandate.card_issued", { mandateId, cardId: card.cardId, last4: card.last4 }, tx);
  }, { behavior: "immediate" });
}

export async function recordCardError(mandateId: string, message: string) {
  await db.update(mandates).set({ cardError: message.slice(0, 300) }).where(eq(mandates.id, mandateId));
}

export async function getMandate(id: string) {
  const [m] = await db.select().from(mandates).where(eq(mandates.id, id)).limit(1);
  return m ?? null;
}

export async function getMandateByToken(token: string) {
  const [m] = await db.select().from(mandates).where(eq(mandates.tokenHash, hashToken(token))).limit(1);
  return m ?? null;
}

export async function getMandateByCard(cardId: string) {
  const [m] = await db.select().from(mandates).where(eq(mandates.stripeCardId, cardId)).limit(1);
  return m ?? null;
}

export async function revokeMandate(id: string, by = "owner") {
  await db.transaction(async (tx) => {
    const r = await tx.update(mandates).set({ status: "revoked", revokedAt: new Date(), tokenReveal: null }).where(and(eq(mandates.id, id), eq(mandates.status, "active")));
    if (r.rowsAffected === 0) return;
    await tx.update(approvals).set({ status: "expired" }).where(and(eq(approvals.mandateId, id), sql`${approvals.status} in ('pending','approved')`));
    await appendEvent("mandate.revoked", { mandateId: id, by }, tx);
  }, { behavior: "immediate" });
}

// ---------- Facts & exposure ----------

export async function factsFor(m: Mandate, now = new Date(), conn: Conn = db, req?: { amount: number; merchant: string }) {
  const dayStart = localDayStart(now, m.timezone);
  const [today] = await conn
    .select({ s: sql<number>`coalesce(sum(${transactions.amount}), 0)` })
    .from(transactions)
    .where(and(eq(transactions.mandateId, m.id), eq(transactions.decision, "approved"), gte(transactions.createdAt, dayStart)));
  const [total] = await conn
    .select({ s: sql<number>`coalesce(sum(${transactions.amount}), 0)` })
    .from(transactions)
    .where(and(eq(transactions.mandateId, m.id), eq(transactions.decision, "approved")));
  const allowances = await conn.select().from(approvals).where(and(eq(approvals.mandateId, m.id), eq(approvals.status, "approved")));
  const [pend] = await conn.select({ c: sql<number>`count(*)` }).from(approvals).where(and(eq(approvals.mandateId, m.id), eq(approvals.status, "pending")));
  let recentlyDenied = false;
  if (req) {
    const since = new Date(now.getTime() - DENIAL_COOLOFF_MS);
    const [d] = await conn.select({ c: sql<number>`count(*)` }).from(approvals).where(and(
      eq(approvals.mandateId, m.id), eq(approvals.status, "denied"), eq(approvals.amount, req.amount),
      sql`lower(${approvals.merchant}) = lower(${req.merchant})`, gte(approvals.decidedAt, since),
    ));
    recentlyDenied = Number(d?.c ?? 0) > 0;
  }
  return { spentToday: Number(today?.s ?? 0), spentTotal: Number(total?.s ?? 0), approvedAllowances: allowances, openPending: Number(pend?.c ?? 0), recentlyDenied };
}

export type Exposure = {
  mandate: Mandate;
  agentName: string;
  effectiveStatus: string;
  spentToday: number;
  spentTotal: number;
  pendingApprovals: number;
  declinedToday: number;
  lastActivity: Date | null;
};

export async function exposureBook(): Promise<Exposure[]> {
  const rows = await db
    .select({ m: mandates, agentName: agents.name })
    .from(mandates)
    .innerJoin(agents, eq(agents.id, mandates.agentId))
    .orderBy(desc(mandates.createdAt));
  const now = new Date();
  const out: Exposure[] = [];
  for (const { m, agentName } of rows) {
    const f = await factsFor(m, now);
    const dayStart = localDayStart(now, m.timezone);
    const [decl] = await db.select({ c: sql<number>`count(*)` }).from(transactions).where(and(eq(transactions.mandateId, m.id), eq(transactions.decision, "declined"), gte(transactions.createdAt, dayStart)));
    const [last] = await db.select({ t: transactions.createdAt }).from(transactions).where(eq(transactions.mandateId, m.id)).orderBy(desc(transactions.createdAt)).limit(1);
    const effectiveStatus = m.status === "active" && m.expiresAt && now > new Date(m.expiresAt) ? "expired" : m.status;
    out.push({ mandate: m, agentName, effectiveStatus, spentToday: f.spentToday, spentTotal: f.spentTotal, pendingApprovals: f.openPending, declinedToday: Number(decl?.c ?? 0), lastActivity: last?.t ?? null });
  }
  return out;
}

export async function countPending(): Promise<number> {
  const [r] = await db.select({ c: sql<number>`count(*)` }).from(approvals).where(eq(approvals.status, "pending"));
  return Number(r?.c ?? 0);
}

// ---------- Authorisation ----------

export type AuthResult = Decision & { transactionId: string; approvalId?: string };

// The single path every purchase attempt goes through, regardless of source.
// Runs inside an IMMEDIATE transaction: the spend sums are read under the
// write lock, so two concurrent attempts cannot both slip under a limit, an
// allowance cannot be consumed twice, and the ledger entry commits with the
// decision or not at all.
export async function authorize(m: Mandate, req: AuthRequest, source: "simulation" | "agent_api" | "stripe", extra: { stripeAuthorizationId?: string } = {}): Promise<AuthResult> {
  const now = req.now ?? new Date();
  const amount = Math.round(req.amount);
  const merchant = req.merchant.trim().slice(0, 120);
  const purpose = (req.purpose ?? "").trim().slice(0, 300);
  const category = (req.category ?? "").trim().slice(0, 64);

  return db.transaction(async (tx) => {
    // Re-read the mandate under the lock so a revoke that just committed is seen.
    const [fresh] = await tx.select().from(mandates).where(eq(mandates.id, m.id)).limit(1);
    const mandate = fresh ?? m;
    const facts = await factsFor(mandate, now, tx, { amount, merchant });
    let d = evaluate(mandate, { amount, merchant, category, purpose, now }, facts);

    let approvalId: string | undefined;
    if (d.decision === "approved" && d.allowanceId) {
      const r = await tx.update(approvals).set({ status: "used", usedAt: now })
        .where(and(eq(approvals.id, d.allowanceId), eq(approvals.status, "approved")));
      if (r.rowsAffected === 1) approvalId = d.allowanceId;
      else d = evaluate(mandate, { amount, merchant, category, purpose, now }, { ...facts, approvedAllowances: [] });
    }
    if (d.decision === "pending") {
      const [existing] = await tx.select().from(approvals).where(and(
        eq(approvals.mandateId, mandate.id), eq(approvals.status, "pending"),
        eq(approvals.amount, amount), sql`lower(${approvals.merchant}) = lower(${merchant})`,
      )).limit(1);
      if (existing) approvalId = existing.id;
      else {
        const a: Approval = { id: randomUUID(), mandateId: mandate.id, amount, currency: mandate.currency, merchant, purpose, status: "pending", requestedAt: now, decidedAt: null, expiresAt: null, usedAt: null };
        await tx.insert(approvals).values(a);
        approvalId = a.id;
        await appendEvent("approval.requested", { approvalId: a.id, mandateId: mandate.id, amount, currency: a.currency, merchant, purpose, source }, tx);
      }
    }

    const t: Transaction = {
      id: randomUUID(), mandateId: mandate.id, amount, currency: mandate.currency,
      merchant, category, purpose,
      decision: d.decision, reason: d.reason, source, stripeAuthorizationId: extra.stripeAuthorizationId ?? null,
      approvalId: d.decision === "approved" ? approvalId ?? null : null, createdAt: now,
    };
    await tx.insert(transactions).values(t);
    await appendEvent(`authorization.${d.decision}`, {
      transactionId: t.id, mandateId: mandate.id, agentId: mandate.agentId, amount, currency: t.currency,
      merchant, purpose, category, rule: d.rule, reason: d.reason, source,
      approvalId: approvalId ?? null, stripeAuthorizationId: t.stripeAuthorizationId,
    }, tx);
    return { ...d, transactionId: t.id, approvalId };
  }, { behavior: "immediate" });
}

// ---------- Approvals ----------

export async function listApprovals(status?: string) {
  const rows = await db
    .select({ a: approvals, mandateName: mandates.name, agentName: agents.name })
    .from(approvals)
    .innerJoin(mandates, eq(mandates.id, approvals.mandateId))
    .innerJoin(agents, eq(agents.id, mandates.agentId))
    .where(status ? eq(approvals.status, status) : undefined)
    .orderBy(desc(approvals.requestedAt))
    .limit(200);
  return rows;
}

export async function decideApproval(id: string, decision: "approved" | "denied", by = "owner") {
  const now = new Date();
  return db.transaction(async (tx) => {
    const [a] = await tx.select().from(approvals).where(eq(approvals.id, id)).limit(1);
    if (!a) return null;
    const r = await tx.update(approvals)
      .set({ status: decision, decidedAt: now, expiresAt: decision === "approved" ? new Date(now.getTime() + ALLOWANCE_TTL_MS) : null })
      .where(and(eq(approvals.id, id), eq(approvals.status, "pending")));
    if (r.rowsAffected === 0) return null;
    await appendEvent(`approval.${decision}`, { approvalId: id, mandateId: a.mandateId, amount: a.amount, currency: a.currency, merchant: a.merchant, by, validForMs: decision === "approved" ? ALLOWANCE_TTL_MS : null }, tx);
    return { ...a, status: decision };
  }, { behavior: "immediate" });
}

// ---------- Activity ----------

export async function recentTransactions(limit = 25, mandateId?: string) {
  return db
    .select({ t: transactions, mandateName: mandates.name, agentName: agents.name })
    .from(transactions)
    .innerJoin(mandates, eq(mandates.id, transactions.mandateId))
    .innerJoin(agents, eq(agents.id, mandates.agentId))
    .where(mandateId ? eq(transactions.mandateId, mandateId) : undefined)
    .orderBy(desc(transactions.createdAt))
    .limit(limit);
}
