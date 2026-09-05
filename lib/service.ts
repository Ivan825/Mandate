import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db, schema, type Tx } from "./db";
import { appendEvent, recordEvent } from "./ledger";
import { evaluate, localDayStart, validateTerms, ALLOWANCE_TTL_MS, DENIAL_COOLOFF_MS, type AuthRequest, type Decision, type TermsError } from "./policy";
import { sendApprovalRequested } from "./notify";
import { checkWarnings } from "./warnings";
import type { Mandate, Approval, Transaction } from "./schema";

const { agents, mandates, transactions, approvals, idempotencyKeys } = schema;

// Every function here is scoped to a workspace. Callers get the workspace
// from the session (lib/session.ts) or from the mandate an agent presents;
// nothing here trusts an id from a URL without checking it belongs.

export const PENDING_TTL_MS = Number(process.env.APPROVAL_TTL_HOURS ?? 24) * 3600 * 1000;

export function newToken(): string { return "mnd_" + randomBytes(24).toString("base64url"); }
export function hashToken(token: string): string { return createHash("sha256").update(token).digest("hex"); }

// ---------- Housekeeping ----------

// A pending request the owner never answers should not wait forever; an
// approved allowance lapses on its own expiry. Both are swept lazily.
export async function expireStale(tx: Tx, workspaceId: string, now = new Date()) {
  const cutoff = new Date(now.getTime() - PENDING_TTL_MS);
  const stale = await tx.update(approvals).set({ status: "expired", decidedAt: now, decidedBy: "system" })
    .where(and(eq(approvals.workspaceId, workspaceId), eq(approvals.status, "pending"), sql`${approvals.requestedAt} < ${cutoff}`)).returning();
  for (const a of stale) await appendEvent(tx, workspaceId, "approval.expired", { approvalId: a.id, mandateId: a.mandateId, amount: a.amount, currency: a.currency, merchant: a.merchant, reason: "unanswered" });
  const lapsed = await tx.update(approvals).set({ status: "expired" })
    .where(and(eq(approvals.workspaceId, workspaceId), eq(approvals.status, "approved"), sql`${approvals.expiresAt} is not null and ${approvals.expiresAt} < ${now}`)).returning();
  for (const a of lapsed) await appendEvent(tx, workspaceId, "approval.expired", { approvalId: a.id, mandateId: a.mandateId, amount: a.amount, currency: a.currency, merchant: a.merchant, reason: "allowance lapsed unused" });
}

export async function sweep(workspaceId: string) {
  await db.transaction((tx) => expireStale(tx, workspaceId));
}

// ---------- Agents ----------

export async function createAgent(workspaceId: string, input: { name: string; description?: string }) {
  const row = { id: randomUUID(), workspaceId, name: input.name.trim().slice(0, 80), description: (input.description ?? "").trim().slice(0, 500), createdAt: new Date() };
  await db.transaction(async (tx) => {
    await tx.insert(agents).values(row);
    await appendEvent(tx, workspaceId, "agent.created", { agentId: row.id, name: row.name });
  });
  return row;
}

export async function listAgents(workspaceId: string) {
  return db.select().from(agents).where(eq(agents.workspaceId, workspaceId)).orderBy(desc(agents.createdAt));
}

// ---------- Mandates ----------

export type MandateInput = {
  agentId: string; name: string; currency: string;
  perTxnLimit: number; dailyLimit: number; totalLimit: number; approvalAbove: number | null;
  allowedMerchants: string[]; blockedCategories: string[];
  activeHoursStart: number; activeHoursEnd: number; timezone: string; expiresAt: Date | null;
};

export type CreateResult = { ok: true; mandate: Mandate; token: string } | { ok: false; errors: TermsError[] };

export async function createMandate(workspaceId: string, input: MandateInput): Promise<CreateResult> {
  const currency = input.currency.toUpperCase();
  const errors = validateTerms({ ...input, currency });
  const [agent] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, input.agentId), eq(agents.workspaceId, workspaceId))).limit(1);
  if (!agent) errors.push({ field: "agentId", message: "Pick an agent in this workspace." });
  if (errors.length) return { ok: false, errors };
  const token = newToken();
  const row: Mandate = {
    id: randomUUID(), workspaceId, agentId: input.agentId, name: input.name.trim().slice(0, 80), status: "active", currency,
    perTxnLimit: input.perTxnLimit, dailyLimit: input.dailyLimit, totalLimit: input.totalLimit, approvalAbove: input.approvalAbove,
    allowedMerchants: JSON.stringify(input.allowedMerchants.map((s) => s.trim().slice(0, 80)).filter(Boolean).slice(0, 50)),
    blockedCategories: JSON.stringify(input.blockedCategories.map((s) => s.trim().slice(0, 64)).filter(Boolean).slice(0, 50)),
    activeHoursStart: input.activeHoursStart, activeHoursEnd: input.activeHoursEnd, timezone: input.timezone, expiresAt: input.expiresAt,
    tokenHash: hashToken(token), tokenPrefix: token.slice(0, 10), tokenReveal: token,
    stripeCardholderId: null, stripeCardId: null, cardLast4: null, cardError: null, createdAt: new Date(), revokedAt: null,
  };
  await db.transaction(async (tx) => {
    await tx.insert(mandates).values(row);
    await appendEvent(tx, workspaceId, "mandate.issued", {
      mandateId: row.id, agentId: row.agentId, name: row.name, currency: row.currency,
      perTxnLimit: row.perTxnLimit, dailyLimit: row.dailyLimit, totalLimit: row.totalLimit, approvalAbove: row.approvalAbove,
      allowedMerchants: JSON.parse(row.allowedMerchants), blockedCategories: JSON.parse(row.blockedCategories),
      activeHours: [row.activeHoursStart, row.activeHoursEnd], timezone: row.timezone,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null, tokenPrefix: row.tokenPrefix,
    });
  });
  return { ok: true, mandate: row, token };
}

// The plaintext token, available only inside the reveal window (lib/reveal.ts).
export async function revealToken(workspaceId: string, mandateId: string): Promise<string | null> {
  const [m] = await db.select({ t: mandates.tokenReveal }).from(mandates).where(and(eq(mandates.id, mandateId), eq(mandates.workspaceId, workspaceId))).limit(1);
  return m?.t ?? null;
}

export async function attachCard(workspaceId: string, mandateId: string, card: { cardholderId: string; cardId: string; last4: string }) {
  await db.transaction(async (tx) => {
    await tx.update(mandates).set({ stripeCardholderId: card.cardholderId, stripeCardId: card.cardId, cardLast4: card.last4, cardError: null }).where(and(eq(mandates.id, mandateId), eq(mandates.workspaceId, workspaceId)));
    await appendEvent(tx, workspaceId, "mandate.card_issued", { mandateId, cardId: card.cardId, last4: card.last4 });
  });
}

export async function recordCardError(workspaceId: string, mandateId: string, message: string) {
  await db.update(mandates).set({ cardError: message.slice(0, 300) }).where(and(eq(mandates.id, mandateId), eq(mandates.workspaceId, workspaceId)));
}

export async function getMandate(workspaceId: string, id: string) {
  const [m] = await db.select().from(mandates).where(and(eq(mandates.id, id), eq(mandates.workspaceId, workspaceId))).limit(1);
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

export async function listMandates(workspaceId: string, onlyActive = false) {
  const rows = await db.select({ m: mandates, agentName: agents.name }).from(mandates).innerJoin(agents, eq(agents.id, mandates.agentId))
    .where(eq(mandates.workspaceId, workspaceId)).orderBy(desc(mandates.createdAt));
  return onlyActive ? rows.filter((r) => r.m.status === "active" && !(r.m.expiresAt && new Date() > new Date(r.m.expiresAt))) : rows;
}

export async function revokeMandate(workspaceId: string, id: string, by: string) {
  await db.transaction(async (tx) => {
    const r = await tx.update(mandates).set({ status: "revoked", revokedAt: new Date(), tokenReveal: null })
      .where(and(eq(mandates.id, id), eq(mandates.workspaceId, workspaceId), eq(mandates.status, "active"))).returning({ id: mandates.id });
    if (r.length === 0) return;
    await tx.update(approvals).set({ status: "expired" }).where(and(eq(approvals.mandateId, id), sql`${approvals.status} in ('pending','approved')`));
    await appendEvent(tx, workspaceId, "mandate.revoked", { mandateId: id, by });
  });
}

// ---------- Facts & exposure ----------

type Q = Tx | typeof db;

export async function factsFor(m: Mandate, now = new Date(), conn: Q = db, req?: { amount: number; merchant: string }) {
  const dayStart = localDayStart(now, m.timezone);
  const [today] = await conn.select({ s: sql<number>`coalesce(sum(${transactions.amount}), 0)::int` }).from(transactions)
    .where(and(eq(transactions.mandateId, m.id), eq(transactions.decision, "approved"), gte(transactions.createdAt, dayStart)));
  const [total] = await conn.select({ s: sql<number>`coalesce(sum(${transactions.amount}), 0)::int` }).from(transactions)
    .where(and(eq(transactions.mandateId, m.id), eq(transactions.decision, "approved")));
  const allowances = await conn.select().from(approvals).where(and(eq(approvals.mandateId, m.id), eq(approvals.status, "approved")));
  const [pend] = await conn.select({ c: sql<number>`count(*)::int` }).from(approvals).where(and(eq(approvals.mandateId, m.id), eq(approvals.status, "pending")));
  let recentlyDenied = false;
  if (req) {
    const since = new Date(now.getTime() - DENIAL_COOLOFF_MS);
    const [d] = await conn.select({ c: sql<number>`count(*)::int` }).from(approvals).where(and(
      eq(approvals.mandateId, m.id), eq(approvals.status, "denied"), eq(approvals.amount, req.amount),
      sql`lower(${approvals.merchant}) = lower(${req.merchant})`, gte(approvals.decidedAt, since),
    ));
    recentlyDenied = Number(d?.c ?? 0) > 0;
  }
  return { spentToday: Number(today?.s ?? 0), spentTotal: Number(total?.s ?? 0), approvedAllowances: allowances, openPending: Number(pend?.c ?? 0), recentlyDenied };
}

export type Exposure = {
  mandate: Mandate; agentName: string; effectiveStatus: string;
  spentToday: number; spentTotal: number; pendingApprovals: number; declinedToday: number; lastActivity: Date | null;
};

export async function exposureBook(workspaceId: string): Promise<Exposure[]> {
  const rows = await listMandates(workspaceId);
  const now = new Date();
  // Two grouped queries for the whole workspace instead of five per mandate.
  const totals = await db.select({ mandateId: transactions.mandateId, decision: transactions.decision, sum: sql<number>`coalesce(sum(${transactions.amount}),0)::int`, count: sql<number>`count(*)::int`, last: sql<Date>`max(${transactions.createdAt})` })
    .from(transactions).where(eq(transactions.workspaceId, workspaceId)).groupBy(transactions.mandateId, transactions.decision);
  const pendings = await db.select({ mandateId: approvals.mandateId, c: sql<number>`count(*)::int` }).from(approvals)
    .where(and(eq(approvals.workspaceId, workspaceId), eq(approvals.status, "pending"))).groupBy(approvals.mandateId);
  const pendingBy = new Map(pendings.map((p) => [p.mandateId, Number(p.c)]));
  const out: Exposure[] = [];
  for (const { m, agentName } of rows) {
    const dayStart = localDayStart(now, m.timezone);
    // "Today" needs the mandate's own timezone, so it stays a small per-mandate query.
    const [today] = await db.select({ s: sql<number>`coalesce(sum(${transactions.amount}),0)::int` }).from(transactions)
      .where(and(eq(transactions.mandateId, m.id), eq(transactions.decision, "approved"), gte(transactions.createdAt, dayStart)));
    const [declToday] = await db.select({ c: sql<number>`count(*)::int` }).from(transactions)
      .where(and(eq(transactions.mandateId, m.id), eq(transactions.decision, "declined"), gte(transactions.createdAt, dayStart)));
    const mine = totals.filter((t) => t.mandateId === m.id);
    const spentTotal = Number(mine.find((t) => t.decision === "approved")?.sum ?? 0);
    const last = mine.reduce<Date | null>((acc, t) => (t.last && (!acc || new Date(t.last) > acc) ? new Date(t.last) : acc), null);
    const effectiveStatus = m.status === "active" && m.expiresAt && now > new Date(m.expiresAt) ? "expired" : m.status;
    out.push({ mandate: m, agentName, effectiveStatus, spentToday: Number(today?.s ?? 0), spentTotal, pendingApprovals: pendingBy.get(m.id) ?? 0, declinedToday: Number(declToday?.c ?? 0), lastActivity: last });
  }
  return out;
}

export async function countPending(workspaceId: string): Promise<number> {
  await sweep(workspaceId);
  const [r] = await db.select({ c: sql<number>`count(*)::int` }).from(approvals).where(and(eq(approvals.workspaceId, workspaceId), eq(approvals.status, "pending")));
  return Number(r?.c ?? 0);
}

// ---------- Authorisation ----------

export type Source = "simulation" | "agent_api" | "mcp" | "stripe" | "proxy";
export type AuthResult = Decision & { transactionId: string; approvalId?: string; notified?: boolean };

// The single path every purchase attempt goes through, regardless of source.
// The mandate row is locked FOR UPDATE for the duration, so two concurrent
// attempts on one mandate are decided one after the other against fresh
// sums; an allowance is consumed at most once; the ledger entry commits with
// the decision or not at all.
export async function authorize(m: Mandate, req: AuthRequest, source: Source, extra: { stripeAuthorizationId?: string; actor?: string } = {}): Promise<AuthResult> {
  const now = req.now ?? new Date();
  const amount = Math.round(req.amount);
  const merchant = req.merchant.trim().slice(0, 120);
  const purpose = (req.purpose ?? "").trim().slice(0, 300);
  const category = (req.category ?? "").trim().slice(0, 64);
  const actor = (extra.actor ?? "").slice(0, 120);

  let newApproval: Approval | null = null;
  const result = await db.transaction(async (tx) => {
    const [mandate] = await tx.select().from(mandates).where(eq(mandates.id, m.id)).for("update").limit(1);
    if (!mandate) throw new Error("Mandate vanished.");
    const ws = mandate.workspaceId;
    await expireStale(tx, ws, now);
    const facts = await factsFor(mandate, now, tx, { amount, merchant });
    let d = evaluate(mandate, { amount, merchant, category, purpose, now }, facts);

    let approvalId: string | undefined;
    if (d.decision === "approved" && d.allowanceId) {
      const r = await tx.update(approvals).set({ status: "used", usedAt: now })
        .where(and(eq(approvals.id, d.allowanceId), eq(approvals.status, "approved"))).returning({ id: approvals.id });
      if (r.length === 1) approvalId = d.allowanceId;
      else d = evaluate(mandate, { amount, merchant, category, purpose, now }, { ...facts, approvedAllowances: [] });
    }
    if (d.decision === "pending") {
      const [existing] = await tx.select().from(approvals).where(and(
        eq(approvals.mandateId, mandate.id), eq(approvals.status, "pending"),
        eq(approvals.amount, amount), sql`lower(${approvals.merchant}) = lower(${merchant})`,
      )).limit(1);
      if (existing) approvalId = existing.id;
      else {
        const a: Approval = { id: randomUUID(), workspaceId: ws, mandateId: mandate.id, amount, currency: mandate.currency, merchant, purpose, status: "pending", requestedAt: now, decidedAt: null, decidedBy: null, expiresAt: null, usedAt: null };
        await tx.insert(approvals).values(a);
        approvalId = a.id;
        newApproval = a;
        await appendEvent(tx, ws, "approval.requested", { approvalId: a.id, mandateId: mandate.id, amount, currency: a.currency, merchant, purpose, source, actor });
      }
    }

    const t: Transaction = {
      id: randomUUID(), workspaceId: ws, mandateId: mandate.id, amount, currency: mandate.currency, merchant, category, purpose,
      decision: d.decision, reason: d.reason, source, actor, stripeAuthorizationId: extra.stripeAuthorizationId ?? null,
      approvalId: d.decision === "approved" ? approvalId ?? null : null, createdAt: now,
    };
    await tx.insert(transactions).values(t);
    await appendEvent(tx, ws, `authorization.${d.decision}`, {
      transactionId: t.id, mandateId: mandate.id, agentId: mandate.agentId, amount, currency: t.currency, merchant, purpose, category,
      rule: d.rule, reason: d.reason, source, actor, approvalId: approvalId ?? null, stripeAuthorizationId: t.stripeAuthorizationId,
    });
    return { ...d, transactionId: t.id, approvalId, mandate };
  });

  // Notify only once the request is durably recorded, and never let a slow
  // channel hold up the agent's answer.
  let notified = false;
  if (newApproval) {
    const a = newApproval as Approval;
    const [ag] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, result.mandate.agentId)).limit(1);
    const outcomes = await sendApprovalRequested({ approval: a, mandate: result.mandate, agentName: ag?.name ?? "Agent" });
    notified = outcomes.some((o) => o.ok);
    for (const o of outcomes) if (!o.ok) console.error(`notify ${o.channel} failed: ${o.error}`);
    if (outcomes.length) await recordEvent(result.mandate.workspaceId, "approval.notified", { approvalId: a.id, channels: outcomes });
  }
  if (result.decision === "approved") {
    const [ag] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, result.mandate.agentId)).limit(1);
    const f = await factsFor(result.mandate, now);
    await checkWarnings(result.mandate, ag?.name ?? "Agent", f);
  }
  const { mandate: _m, ...rest } = result;
  void _m;
  return { ...rest, notified };
}

// ---------- Idempotency ----------

export async function getIdempotent(mandateId: string, key: string) {
  const [row] = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.id, `${mandateId}:${key}`)).limit(1);
  return row ?? null;
}

export async function putIdempotent(mandateId: string, key: string, status: number, response: unknown) {
  await db.insert(idempotencyKeys).values({ id: `${mandateId}:${key}`, mandateId, status, response: JSON.stringify(response), createdAt: new Date() }).onConflictDoNothing();
}

// ---------- Approvals ----------

export async function listApprovals(workspaceId: string, status?: string) {
  await sweep(workspaceId);
  return db.select({ a: approvals, mandateName: mandates.name, agentName: agents.name }).from(approvals)
    .innerJoin(mandates, eq(mandates.id, approvals.mandateId)).innerJoin(agents, eq(agents.id, mandates.agentId))
    .where(status ? and(eq(approvals.workspaceId, workspaceId), eq(approvals.status, status)) : eq(approvals.workspaceId, workspaceId))
    .orderBy(desc(approvals.requestedAt)).limit(200);
}

export async function getApproval(id: string) {
  const [row] = await db.select({ a: approvals, mandateName: mandates.name, agentName: agents.name }).from(approvals)
    .innerJoin(mandates, eq(mandates.id, approvals.mandateId)).innerJoin(agents, eq(agents.id, mandates.agentId))
    .where(eq(approvals.id, id)).limit(1);
  return row ?? null;
}

export async function decideApproval(workspaceId: string | null, id: string, decision: "approved" | "denied", by: string) {
  const now = new Date();
  return db.transaction(async (tx) => {
    const [a] = await tx.select().from(approvals).where(eq(approvals.id, id)).for("update").limit(1);
    if (!a || (workspaceId && a.workspaceId !== workspaceId)) return null;
    const r = await tx.update(approvals)
      .set({ status: decision, decidedAt: now, decidedBy: by, expiresAt: decision === "approved" ? new Date(now.getTime() + ALLOWANCE_TTL_MS) : null })
      .where(and(eq(approvals.id, id), eq(approvals.status, "pending"))).returning({ id: approvals.id });
    if (r.length === 0) return null;
    await appendEvent(tx, a.workspaceId, `approval.${decision}`, { approvalId: id, mandateId: a.mandateId, amount: a.amount, currency: a.currency, merchant: a.merchant, by, validForMs: decision === "approved" ? ALLOWANCE_TTL_MS : null });
    return { ...a, status: decision };
  });
}

// ---------- Activity ----------

export async function recentTransactions(workspaceId: string, limit = 25, mandateId?: string) {
  return db.select({ t: transactions, mandateName: mandates.name, agentName: agents.name }).from(transactions)
    .innerJoin(mandates, eq(mandates.id, transactions.mandateId)).innerJoin(agents, eq(agents.id, mandates.agentId))
    .where(mandateId ? and(eq(transactions.workspaceId, workspaceId), eq(transactions.mandateId, mandateId)) : eq(transactions.workspaceId, workspaceId))
    .orderBy(desc(transactions.createdAt)).limit(limit);
}

// ---------- Cardholder profile (Stripe Issuing) ----------

export async function getCardholderProfile(workspaceId: string) {
  const [p] = await db.select().from(schema.cardholderProfiles).where(eq(schema.cardholderProfiles.workspaceId, workspaceId)).limit(1);
  return p ?? null;
}

export async function saveCardholderProfile(workspaceId: string, p: Omit<typeof schema.cardholderProfiles.$inferInsert, "workspaceId" | "updatedAt">) {
  const row = { ...p, workspaceId, updatedAt: new Date() };
  await db.insert(schema.cardholderProfiles).values(row).onConflictDoUpdate({ target: schema.cardholderProfiles.workspaceId, set: row });
}

// ---------- Card reconciliation ----------

// Stripe tells us later what actually happened to an authorisation: it was
// captured (possibly for less), reversed, or refunded. The approved
// transaction is adjusted so the mandate's sums reflect money that moved.
export async function reconcileCard(stripeAuthorizationId: string, kind: "capture" | "reversal" | "refund", amount: number, ref: string) {
  const [t] = await db.select().from(transactions).where(eq(transactions.stripeAuthorizationId, stripeAuthorizationId)).limit(1);
  if (!t) return false;
  await db.transaction(async (tx) => {
    if (kind === "capture") {
      await tx.update(transactions).set({ amount, reason: `Captured ${amount} of ${t.amount} authorised.` }).where(eq(transactions.id, t.id));
    } else if (kind === "reversal") {
      await tx.update(transactions).set({ amount: 0, reason: "Authorisation reversed by the network; nothing charged." }).where(eq(transactions.id, t.id));
    } else {
      // A refund is a negative approved transaction so daily/total sums net down.
      await tx.insert(transactions).values({ id: randomUUID(), workspaceId: t.workspaceId, mandateId: t.mandateId, amount: -Math.abs(amount), currency: t.currency, merchant: t.merchant, category: t.category, purpose: `Refund of ${t.purpose || "card purchase"}`, decision: "approved", reason: "Refund from merchant.", source: "stripe", actor: t.actor, stripeAuthorizationId: null, approvalId: null, createdAt: new Date() });
    }
    await appendEvent(tx, t.workspaceId, `stripe.${kind}`, { transactionId: t.id, mandateId: t.mandateId, stripeAuthorizationId, amount, ref });
  });
  return true;
}
