import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db, schema, type Tx } from "./db";
import { appendEvent, recordEvent } from "./ledger";
import { evaluate, localDayStart, validateTerms, validateHoldTerms, validateVetoTerms, validateAutonomyTerms, parsePlanItems, ALLOWANCE_TTL_MS, DENIAL_COOLOFF_MS, type AuthRequest, type Decision, type Facts, type TermsError, type PlanItem } from "./policy";
import { isCurrencyCode } from "./money";
import { computeFlags, type Flag } from "./anomaly";
import type { MandateOverride, Plan } from "./schema";
import { sendApprovalRequested } from "./notify";
import { checkWarnings } from "./warnings";
import { sweepReveals } from "./reveal";
import { availableBalance, lockBalance } from "./balance";
import type { Mandate, Approval, Transaction } from "./schema";

const { agents, mandates, transactions, approvals, idempotencyKeys } = schema;

// Every function here is scoped to a workspace. Callers get the workspace
// from the session (lib/session.ts) or from the mandate an agent presents;
// nothing here trusts an id from a URL without checking it belongs.

export const PENDING_TTL_MS = Number(process.env.APPROVAL_TTL_HOURS ?? 24) * 3600 * 1000;

export function newToken(): string { return "mnd_" + randomBytes(24).toString("base64url"); }
function dedupe(errs: TermsError[]): TermsError[] { const seen = new Set<string>(); return errs.filter((e) => { const k = e.field + "|" + e.message; if (seen.has(k)) return false; seen.add(k); return true; }); }
export function hashToken(token: string): string { return createHash("sha256").update(token).digest("hex"); }

// ---------- Housekeeping ----------

// A pending request the owner never answers should not wait forever; an
// approved allowance lapses on its own expiry. Both are swept lazily.
export async function expireStale(tx: Tx, workspaceId: string, now = new Date()) {
  const cutoff = new Date(now.getTime() - PENDING_TTL_MS);
  const stale = await tx.update(approvals).set({ status: "expired", decidedAt: now, decidedBy: "system" })
    .where(and(eq(approvals.workspaceId, workspaceId), eq(approvals.status, "pending"), sql`${approvals.kind} <> 'veto'`, sql`${approvals.requestedAt} < ${cutoff}`)).returning();
  for (const a of stale) await appendEvent(tx, workspaceId, "approval.expired", { approvalId: a.id, mandateId: a.mandateId, amount: a.amount, currency: a.currency, merchant: a.merchant, reason: "unanswered" });
  const lapsed = await tx.update(approvals).set({ status: "expired" })
    .where(and(eq(approvals.workspaceId, workspaceId), eq(approvals.status, "approved"), sql`${approvals.expiresAt} is not null and ${approvals.expiresAt} < ${now}`)).returning();
  for (const a of lapsed) await appendEvent(tx, workspaceId, "approval.expired", { approvalId: a.id, mandateId: a.mandateId, amount: a.amount, currency: a.currency, merchant: a.merchant, reason: "allowance lapsed unused" });
  // Veto windows that closed without objection become allowances (24 h).
  const matured = await tx.update(approvals).set({ status: "approved", decidedAt: now, decidedBy: "silence", expiresAt: new Date(now.getTime() + ALLOWANCE_TTL_MS) })
    .where(and(eq(approvals.workspaceId, workspaceId), eq(approvals.status, "pending"), eq(approvals.kind, "veto"), sql`${approvals.vetoUntil} is not null and ${approvals.vetoUntil} <= ${now}`)).returning();
  for (const a of matured) await appendEvent(tx, workspaceId, "approval.approved", { approvalId: a.id, mandateId: a.mandateId, amount: a.amount, currency: a.currency, merchant: a.merchant, by: "silence", validForMs: ALLOWANCE_TTL_MS, kind: "veto" });
  const lapsedPlans = await tx.update(schema.plans).set({ status: "expired" })
    .where(and(eq(schema.plans.workspaceId, workspaceId), sql`${schema.plans.status} in ('proposed','approved')`, sql`${schema.plans.expiresAt} is not null and ${schema.plans.expiresAt} < ${now}`)).returning({ id: schema.plans.id, mandateId: schema.plans.mandateId });
  for (const pl of lapsedPlans) await appendEvent(tx, workspaceId, "plan.expired", { planId: pl.id, mandateId: pl.mandateId });
  await closeExpiredHolds(tx, now, workspaceId);
  // Pauses that have run their course.
  const resumed = await tx.update(mandates).set({ status: "active", pausedUntil: null, pausedBy: null })
    .where(and(eq(mandates.workspaceId, workspaceId), eq(mandates.status, "paused"), sql`${mandates.pausedUntil} is not null and ${mandates.pausedUntil} <= ${now}`)).returning({ id: mandates.id });
  for (const r of resumed) await appendEvent(tx, workspaceId, "mandate.resumed", { mandateId: r.id, by: "system", reason: "pause ended" });
}

export async function sweep(workspaceId: string) {
  await db.transaction((tx) => expireStale(tx, workspaceId));
}

// A hold the agent never settled is closed by the mandate's policy once its
// TTL is up: captured in full (the safe assumption — the money probably
// moved and nobody told us) or released back to the limits. Runs lazily for
// one workspace on every authorisation, and for all workspaces from cron.
export async function closeExpiredHolds(tx: Tx, now = new Date(), workspaceId?: string, limit = 200): Promise<number> {
  const due = await tx.select({ t: transactions, policy: mandates.holdPolicy }).from(transactions).innerJoin(mandates, eq(mandates.id, transactions.mandateId))
    .where(and(eq(transactions.settlement, "held"), sql`${transactions.holdExpiresAt} is not null and ${transactions.holdExpiresAt} <= ${now}`, workspaceId ? eq(transactions.workspaceId, workspaceId) : undefined))
    .orderBy(transactions.holdExpiresAt).limit(limit).for("update", { of: transactions, skipLocked: true });
  for (const { t, policy } of due) {
    const release = policy === "release";
    await tx.update(transactions).set({
      settlement: release ? "released" : "captured", amount: release ? 0 : t.amount, settledAt: now, settledBy: "system",
      settlementNote: release ? "Hold expired unsettled; released under the mandate's policy." : "Hold expired unsettled; captured in full under the mandate's policy.",
    }).where(eq(transactions.id, t.id));
    await appendEvent(tx, t.workspaceId, release ? "authorization.released" : "authorization.captured", {
      transactionId: t.id, mandateId: t.mandateId, authorizedAmount: t.authorizedAmount ?? t.amount, capturedAmount: release ? 0 : t.amount, released: release ? t.amount : 0,
      currency: t.currency, merchant: t.merchant, by: "system", reason: "hold expired", policy,
    });
  }
  return due.length;
}

export async function sweepAllHolds(limit = 200): Promise<number> {
  return db.transaction((tx) => closeExpiredHolds(tx, new Date(), undefined, limit));
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
  holdTtlHours?: number; holdPolicy?: "capture" | "release";
  vetoAbove?: number | null; vetoMinutes?: number;
  autonomyStep?: number; autonomyEvery?: number; autonomyCeiling?: number | null;
  mode?: "enforce" | "observe";
};

export type CreateResult = { ok: true; mandate: Mandate; token: string } | { ok: false; errors: TermsError[] };

export async function createMandate(workspaceId: string, input: MandateInput): Promise<CreateResult> {
  const currency = input.currency.toUpperCase();
  const holdTtlHours = input.holdTtlHours ?? 24;
  const holdPolicy = input.holdPolicy ?? "capture";
  const vetoAbove = input.vetoAbove ?? null;
  const vetoMinutes = input.vetoMinutes ?? 15;
  const autonomyStep = input.autonomyStep ?? 0;
  const autonomyEvery = input.autonomyEvery ?? 10;
  const autonomyCeiling = autonomyStep > 0 ? input.autonomyCeiling ?? null : null;
  const mode = input.mode === "observe" ? "observe" : "enforce";
  const errors = [...validateTerms({ ...input, currency }), ...validateHoldTerms({ holdTtlHours, holdPolicy }), ...validateVetoTerms({ vetoAbove, vetoMinutes, approvalAbove: input.approvalAbove, perTxnLimit: input.perTxnLimit }), ...validateAutonomyTerms({ autonomyStep, autonomyEvery, autonomyCeiling, perTxnLimit: input.perTxnLimit })];
  if (!isCurrencyCode(currency)) errors.push({ field: "currency", message: "Currency must be a 3-letter ISO code." });
  const [agent] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, input.agentId), eq(agents.workspaceId, workspaceId))).limit(1);
  if (!agent) errors.push({ field: "agentId", message: "Pick an agent in this workspace." });
  if (errors.length) return { ok: false, errors: dedupe(errors) };
  const token = newToken();
  const row: Mandate = {
    id: randomUUID(), workspaceId, agentId: input.agentId, name: input.name.trim().slice(0, 80), status: "active", currency,
    perTxnLimit: input.perTxnLimit, dailyLimit: input.dailyLimit, totalLimit: input.totalLimit, approvalAbove: input.approvalAbove,
    allowedMerchants: JSON.stringify(input.allowedMerchants.map((s) => s.trim().slice(0, 80)).filter(Boolean).slice(0, 50)),
    blockedCategories: JSON.stringify(input.blockedCategories.map((s) => s.trim().slice(0, 64)).filter(Boolean).slice(0, 50)),
    activeHoursStart: input.activeHoursStart, activeHoursEnd: input.activeHoursEnd, timezone: input.timezone, expiresAt: input.expiresAt,
    holdTtlHours, holdPolicy, pausedUntil: null, pausedBy: null,
    vetoAbove, vetoMinutes, mode, autonomyStep, autonomyEvery, autonomyCeiling, autonomyLevel: 0, autonomyStreak: 0,
    tokenHash: hashToken(token), tokenPrefix: token.slice(0, 10), tokenReveal: token,
    stripeCardholderId: null, stripeCardId: null, cardLast4: null, cardExp: null, cardStatus: null, cardError: null, createdAt: new Date(), revokedAt: null,
  };
  await db.transaction(async (tx) => {
    await tx.insert(mandates).values(row);
    await appendEvent(tx, workspaceId, "mandate.issued", {
      mandateId: row.id, agentId: row.agentId, name: row.name, currency: row.currency,
      perTxnLimit: row.perTxnLimit, dailyLimit: row.dailyLimit, totalLimit: row.totalLimit, approvalAbove: row.approvalAbove,
      allowedMerchants: JSON.parse(row.allowedMerchants), blockedCategories: JSON.parse(row.blockedCategories),
      activeHours: [row.activeHoursStart, row.activeHoursEnd], timezone: row.timezone,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null, tokenPrefix: row.tokenPrefix,
      holdTtlHours: row.holdTtlHours, holdPolicy: row.holdPolicy, vetoAbove: row.vetoAbove, vetoMinutes: row.vetoMinutes, mode: row.mode,
      autonomy: row.autonomyStep > 0 ? { step: row.autonomyStep, every: row.autonomyEvery, ceiling: row.autonomyCeiling } : null,
    });
  });
  // Any plaintext older than the reveal window is cleared right now, not
  // only when someone next opens a page.
  await sweepReveals().catch(() => {});
  return { ok: true, mandate: row, token };
}

// The plaintext token, available only inside the reveal window (lib/reveal.ts).
export async function revealToken(workspaceId: string, mandateId: string): Promise<string | null> {
  await sweepReveals().catch(() => {});
  const [m] = await db.select({ t: mandates.tokenReveal }).from(mandates).where(and(eq(mandates.id, mandateId), eq(mandates.workspaceId, workspaceId))).limit(1);
  return m?.t ?? null;
}

export async function attachCard(workspaceId: string, mandateId: string, card: { cardholderId: string; cardId: string; last4: string; expMonth?: number; expYear?: number }) {
  await db.transaction(async (tx) => {
    await tx.update(mandates).set({ stripeCardholderId: card.cardholderId, stripeCardId: card.cardId, cardLast4: card.last4, cardStatus: "active", cardExp: card.expMonth && card.expYear ? `${String(card.expMonth).padStart(2, "0")}/${String(card.expYear).slice(-2)}` : null, cardError: null }).where(and(eq(mandates.id, mandateId), eq(mandates.workspaceId, workspaceId)));
    await appendEvent(tx, workspaceId, "mandate.card_issued", { mandateId, cardId: card.cardId, last4: card.last4 });
  });
}

export async function setCardFrozen(workspaceId: string, mandateId: string, frozen: boolean, by: string) {
  await db.transaction(async (tx) => {
    await tx.update(mandates).set({ cardStatus: frozen ? "inactive" : "active" }).where(and(eq(mandates.id, mandateId), eq(mandates.workspaceId, workspaceId)));
    await appendEvent(tx, workspaceId, frozen ? "mandate.card_frozen" : "mandate.card_unfrozen", { mandateId, by });
  });
}

// Stripe tells us when a card or cardholder changes state (fraud block,
// expiry, a cardholder missing a document); mirror it so the pages and the
// decision engine see it.
export async function syncCardStatus(cardId: string, status: string) {
  const [m] = await db.select({ id: mandates.id, workspaceId: mandates.workspaceId, cardStatus: mandates.cardStatus }).from(mandates).where(eq(mandates.stripeCardId, cardId)).limit(1);
  if (!m || m.cardStatus === status) return;
  await db.transaction(async (tx) => {
    await tx.update(mandates).set({ cardStatus: status }).where(eq(mandates.id, m.id));
    await appendEvent(tx, m.workspaceId, "stripe.card_status", { mandateId: m.id, cardId, status });
  });
}

export async function syncCardholderStatus(cardholderId: string, status: string, requirements: string[]) {
  await db.update(schema.cardholderProfiles).set({ cardholderStatus: status, cardholderRequirements: JSON.stringify(requirements) }).where(eq(schema.cardholderProfiles.stripeCardholderId, cardholderId));
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
      .where(and(eq(mandates.id, id), eq(mandates.workspaceId, workspaceId), sql`${mandates.status} in ('active','paused')`)).returning({ id: mandates.id });
    if (r.length === 0) return;
    await tx.update(approvals).set({ status: "expired" }).where(and(eq(approvals.mandateId, id), sql`${approvals.status} in ('pending','approved')`));
    await appendEvent(tx, workspaceId, "mandate.revoked", { mandateId: id, by });
  });
}

// ---------- Pause, resume, temporary raises ----------

// A pause is a freeze, not a revocation: the token survives, every request
// declines with "paused" and a resume time, and the mandate wakes itself
// up when the time comes (or when someone presses Resume).
export async function pauseMandate(workspaceId: string, id: string, opts: { until: Date | null; by: string; reason?: string }) {
  return db.transaction(async (tx) => {
    const r = await tx.update(mandates).set({ status: "paused", pausedUntil: opts.until, pausedBy: opts.by.slice(0, 120) })
      .where(and(eq(mandates.id, id), eq(mandates.workspaceId, workspaceId), sql`${mandates.status} in ('active','paused')`)).returning({ id: mandates.id });
    if (!r.length) return false;
    await appendEvent(tx, workspaceId, "mandate.paused", { mandateId: id, by: opts.by, until: opts.until ? opts.until.toISOString() : null, reason: (opts.reason ?? "").slice(0, 300) });
    return true;
  });
}

export async function resumeMandate(workspaceId: string, id: string, by: string) {
  return db.transaction(async (tx) => {
    const r = await tx.update(mandates).set({ status: "active", pausedUntil: null, pausedBy: null })
      .where(and(eq(mandates.id, id), eq(mandates.workspaceId, workspaceId), eq(mandates.status, "paused"))).returning({ id: mandates.id });
    if (!r.length) return false;
    await appendEvent(tx, workspaceId, "mandate.resumed", { mandateId: id, by, reason: "resumed" });
    return true;
  });
}

export async function activeOverrides(mandateId: string, now = new Date(), conn: Q = db): Promise<MandateOverride[]> {
  return conn.select().from(schema.mandateOverrides).where(and(eq(schema.mandateOverrides.mandateId, mandateId), sql`${schema.mandateOverrides.revokedAt} is null`, sql`${schema.mandateOverrides.startsAt} <= ${now}`, sql`${schema.mandateOverrides.endsAt} > ${now}`));
}

export async function listOverrides(workspaceId: string, mandateId: string): Promise<MandateOverride[]> {
  return db.select().from(schema.mandateOverrides).where(and(eq(schema.mandateOverrides.workspaceId, workspaceId), eq(schema.mandateOverrides.mandateId, mandateId))).orderBy(desc(schema.mandateOverrides.createdAt)).limit(50);
}

export const RAISE_MAX_HOURS = 24 * 30;

// "Let it spend up to X today": a raise on one limit for a window. It has to
// be above the issued term (otherwise it changes nothing) and it ends on
// its own — the base terms are never edited in place, so the ledger's
// record of what was granted stays true.
export async function raiseLimit(workspaceId: string, id: string, input: { field: string; amount: number; endsAt: Date; reason?: string; by: string }): Promise<{ ok: true; override: MandateOverride } | { ok: false; error: string }> {
  const m = await getMandate(workspaceId, id);
  if (!m) return { ok: false, error: "No such mandate." };
  if (m.status !== "active" && m.status !== "paused") return { ok: false, error: `The mandate is ${m.status}.` };
  const field = input.field;
  if (!["per_txn", "daily", "total", "approval_above"].includes(field)) return { ok: false, error: "Pick a limit to raise." };
  if (!Number.isInteger(input.amount) || input.amount <= 0 || input.amount > MAX_AMOUNT) return { ok: false, error: "Enter a positive amount." };
  const base = field === "per_txn" ? m.perTxnLimit : field === "daily" ? m.dailyLimit : field === "total" ? m.totalLimit : m.approvalAbove;
  if (base == null) return { ok: false, error: "This mandate never asks for approval, so there is no threshold to raise." };
  if (input.amount <= base) return { ok: false, error: `That is not above the mandate's own ${field.replace("_", " ")} of ${base}; a raise only goes up.` };
  const now = new Date();
  if (input.endsAt.getTime() <= now.getTime() + 60_000) return { ok: false, error: "The raise must end at least a minute from now." };
  if (input.endsAt.getTime() > now.getTime() + RAISE_MAX_HOURS * 3600_000) return { ok: false, error: "A temporary raise can last at most 30 days; change the mandate's terms by issuing a new one instead." };
  const row: MandateOverride = { id: randomUUID(), workspaceId, mandateId: id, field, amount: input.amount, startsAt: now, endsAt: input.endsAt, reason: (input.reason ?? "").trim().slice(0, 300), createdBy: input.by.slice(0, 120), createdAt: now, revokedAt: null };
  await db.transaction(async (tx) => {
    await tx.insert(schema.mandateOverrides).values(row);
    await appendEvent(tx, workspaceId, "mandate.raised", { mandateId: id, overrideId: row.id, field, amount: input.amount, currency: m.currency, base, endsAt: input.endsAt.toISOString(), reason: row.reason, by: input.by });
  });
  return { ok: true, override: row };
}

export async function withdrawRaise(workspaceId: string, mandateId: string, overrideId: string, by: string) {
  return db.transaction(async (tx) => {
    const r = await tx.update(schema.mandateOverrides).set({ revokedAt: new Date() })
      .where(and(eq(schema.mandateOverrides.id, overrideId), eq(schema.mandateOverrides.workspaceId, workspaceId), eq(schema.mandateOverrides.mandateId, mandateId), sql`${schema.mandateOverrides.revokedAt} is null`)).returning({ field: schema.mandateOverrides.field });
    if (!r.length) return false;
    await appendEvent(tx, workspaceId, "mandate.raise_withdrawn", { mandateId, overrideId, field: r[0].field, by });
    return true;
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
  let recentlyDeniedAt: Date | null = null;
  if (req) {
    const since = new Date(now.getTime() - DENIAL_COOLOFF_MS);
    const [d] = await conn.select({ at: sql<Date | null>`max(${approvals.decidedAt})` }).from(approvals).where(and(
      eq(approvals.mandateId, m.id), eq(approvals.status, "denied"), eq(approvals.amount, req.amount),
      sql`lower(${approvals.merchant}) = lower(${req.merchant})`, gte(approvals.decidedAt, since),
    ));
    recentlyDeniedAt = d?.at ? new Date(d.at) : null;
    recentlyDenied = recentlyDeniedAt !== null;
  }
  const overrides = await activeOverrides(m.id, now, conn);
  const plans = await conn.select().from(schema.plans).where(and(eq(schema.plans.mandateId, m.id), eq(schema.plans.status, "approved")));
  const facts: Facts = { spentToday: Number(today?.s ?? 0), spentTotal: Number(total?.s ?? 0), approvedAllowances: allowances, openPending: Number(pend?.c ?? 0), recentlyDenied, recentlyDeniedAt, availableBalance: null, overrides, plans };
  return facts;
}

export type Exposure = {
  mandate: Mandate; agentName: string; effectiveStatus: string;
  spentToday: number; spentTotal: number; pendingApprovals: number; declinedToday: number; lastActivity: Date | null; openHolds: number;
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
  const holds = await db.select({ mandateId: transactions.mandateId, c: sql<number>`count(*)::int` }).from(transactions)
    .where(and(eq(transactions.workspaceId, workspaceId), eq(transactions.settlement, "held"))).groupBy(transactions.mandateId);
  const holdsBy = new Map(holds.map((h) => [h.mandateId, Number(h.c)]));
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
    const effectiveStatus = m.status === "active" && m.expiresAt && now > new Date(m.expiresAt) ? "expired" : m.status === "paused" && m.pausedUntil && now >= new Date(m.pausedUntil) ? "active" : m.status;
    out.push({ mandate: m, agentName, effectiveStatus, spentToday: Number(today?.s ?? 0), spentTotal, pendingApprovals: pendingBy.get(m.id) ?? 0, declinedToday: Number(declToday?.c ?? 0), lastActivity: last, openHolds: holdsBy.get(m.id) ?? 0 });
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
export type Settlement = "held" | "captured" | "voided" | "released";
export type AuthResult = Decision & { transactionId: string; approvalId?: string; notified?: boolean; settlement: Settlement | null; holdExpiresAt: Date | null; flags: Flag[]; shadow: { decision: string; rule: string; reason: string } | null };
// Postgres int4; also a sanity ceiling no mandate should ever reach.
export const MAX_AMOUNT = 2_147_483_647;

// The single path every purchase attempt goes through, regardless of source.
// The mandate row is locked FOR UPDATE for the duration, so two concurrent
// attempts on one mandate are decided one after the other against fresh
// sums; an allowance is consumed at most once; the ledger entry commits with
// the decision or not at all.
export async function authorize(m: Mandate, req: AuthRequest, source: Source, extra: { stripeAuthorizationId?: string; actor?: string; background?: (work: () => Promise<void>) => void } = {}): Promise<AuthResult> {
  const now = req.now ?? new Date();
  const amount = Math.round(req.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) throw new Error(`amount must be between 1 and ${MAX_AMOUNT} minor units.`);
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
    if (source === "stripe") {
      // Cards draw on the workspace's prepaid balance: one card at a time.
      await lockBalance(tx, ws);
      facts.availableBalance = await availableBalance(ws, mandate.currency, tx);
    }
    let d = evaluate(mandate, { amount, merchant, category, purpose, now }, facts);
    const flags: Flag[] = source === "simulation" ? [] : await computeFlags(tx, mandate.id, { amount, merchant }, now).catch(() => []);

    // Shadow mode: the terms are consulted, their verdict is recorded, and
    // the request goes through regardless. Escalations don't happen (nobody
    // is asked), which is the point of observing before enforcing.
    let shadow: { decision: string; rule: string; reason: string } | null = null;
    if (mandate.mode === "observe" && d.decision !== "approved") {
      shadow = { decision: d.decision, rule: d.rule, reason: d.reason };
      d = { decision: "approved", reason: `Observing: the terms would have ${d.decision === "pending" ? "asked you" : "declined"} (${d.rule}). Let through unenforced.`, rule: "observe" };
    } else if (mandate.mode === "observe") {
      shadow = { decision: "approved", rule: d.rule, reason: d.reason };
    }

    let approvalId: string | undefined;
    let planId: string | null = null;
    if (d.decision === "approved" && d.allowanceId) {
      const r = await tx.update(approvals).set({ status: "used", usedAt: now })
        .where(and(eq(approvals.id, d.allowanceId), eq(approvals.status, "approved"))).returning({ id: approvals.id });
      if (r.length === 1) approvalId = d.allowanceId;
      else d = evaluate(mandate, { amount, merchant, category, purpose, now }, { ...facts, approvedAllowances: [] });
    }
    if (d.decision === "approved" && d.planId != null && d.planItem != null) {
      // Consume the plan item under the row lock; a plan whose items are all used is complete.
      const [pl] = await tx.select().from(schema.plans).where(eq(schema.plans.id, d.planId)).for("update").limit(1);
      const items = pl ? parsePlanItems(pl.items) : [];
      if (pl && pl.status === "approved" && items[d.planItem] && !items[d.planItem].usedBy) {
        items[d.planItem].usedBy = "pending"; // replaced with the transaction id below
        planId = pl.id;
      } else {
        d = evaluate(mandate, { amount, merchant, category, purpose, now }, { ...facts, plans: [] });
      }
      if (planId && pl) {
        const complete = items.every((it) => it.usedBy);
        await tx.update(schema.plans).set({ items: JSON.stringify(items), status: complete ? "completed" : "approved" }).where(eq(schema.plans.id, pl.id));
        if (complete) await appendEvent(tx, ws, "plan.completed", { planId: pl.id, mandateId: mandate.id, title: pl.title });
      }
    }
    if (d.decision === "pending") {
      const veto = d.rule === "veto";
      const [existing] = await tx.select().from(approvals).where(and(
        eq(approvals.mandateId, mandate.id), eq(approvals.status, "pending"),
        eq(approvals.amount, amount), sql`lower(${approvals.merchant}) = lower(${merchant})`,
      )).limit(1);
      if (existing) { approvalId = existing.id; if (existing.vetoUntil) d.remedy.retryAt = new Date(existing.vetoUntil).toISOString(); }
      else {
        const vetoUntil = veto ? new Date(now.getTime() + mandate.vetoMinutes * 60_000) : null;
        const a: Approval = { id: randomUUID(), workspaceId: ws, mandateId: mandate.id, amount, currency: mandate.currency, merchant, purpose, status: "pending", requestedAt: now, decidedAt: null, decidedBy: null, expiresAt: null, usedAt: null, flags: JSON.stringify(flags), kind: veto ? "veto" : "ask", vetoUntil, signedWith: null, signature: null };
        await tx.insert(approvals).values(a);
        approvalId = a.id;
        newApproval = a;
        if (vetoUntil) d.remedy.retryAt = vetoUntil.toISOString();
        await appendEvent(tx, ws, "approval.requested", { approvalId: a.id, mandateId: mandate.id, amount, currency: a.currency, merchant, purpose, source, actor, flags, kind: a.kind, vetoUntil: vetoUntil ? vetoUntil.toISOString() : null });
      }
    }

    // How the money side of an approval is tracked depends on who settles it:
    // agents (REST, MCP) capture or void explicitly, within the mandate's
    // hold TTL; the proxy settles on the provider's usage (an hour's grace
    // covers a function that dies mid-stream); Stripe drives card holds; a
    // simulation is the owner poking the terms and settles at once.
    const approved = d.decision === "approved";
    const settlement = !approved ? null
      : source === "simulation" || (source !== "stripe" && source !== "proxy" && mandate.holdTtlHours === 0) ? "captured"
      : "held";
    const holdExpiresAt = settlement !== "held" ? null
      : source === "stripe" ? null
      : source === "proxy" ? new Date(now.getTime() + 3600_000)
      : new Date(now.getTime() + mandate.holdTtlHours * 3600_000);
    const t: Transaction = {
      id: randomUUID(), workspaceId: ws, mandateId: mandate.id, amount, currency: mandate.currency, merchant, category, purpose,
      decision: d.decision, reason: d.reason, source, actor, stripeAuthorizationId: extra.stripeAuthorizationId ?? null,
      approvalId: approved ? approvalId ?? null : null,
      authorizedAmount: approved ? amount : null, settlement, holdExpiresAt,
      settledAt: settlement === "captured" ? now : null, settledBy: settlement === "captured" ? "system" : null,
      settlementNote: settlement === "captured" ? (source === "simulation" ? "Simulated purchase; settled at once." : "Mandate settles at once (hold TTL 0).") : null,
      flags: JSON.stringify(flags), shareToken: null,
      shadowDecision: shadow?.decision ?? null, shadowRule: shadow?.rule ?? null, shadowReason: shadow?.reason ?? null, planId,
      createdAt: now,
    };
    await tx.insert(transactions).values(t);
    if (planId) {
      const [pl] = await tx.select({ items: schema.plans.items }).from(schema.plans).where(eq(schema.plans.id, planId)).limit(1);
      if (pl) { const items = parsePlanItems(pl.items); for (const it of items) if (it.usedBy === "pending") it.usedBy = t.id; await tx.update(schema.plans).set({ items: JSON.stringify(items) }).where(eq(schema.plans.id, planId)); }
    }
    await appendEvent(tx, ws, `authorization.${d.decision}`, {
      transactionId: t.id, mandateId: mandate.id, agentId: mandate.agentId, amount, currency: t.currency, merchant, purpose, category,
      rule: d.rule, reason: d.reason, source, actor, approvalId: approvalId ?? null, stripeAuthorizationId: t.stripeAuthorizationId,
      settlement, holdExpiresAt: holdExpiresAt ? holdExpiresAt.toISOString() : null, flags,
      shadow: shadow ? { decision: shadow.decision, rule: shadow.rule } : undefined, planId: planId ?? undefined,
    });
    // Graduated autonomy: a clean, enforced approval advances the streak; a
    // decline burst (the agent thrashing) steps the earned level back down.
    if (mandate.autonomyStep > 0 && source !== "simulation" && mandate.mode === "enforce") await autonomyTick(tx, mandate, d.decision === "approved" && flags.length === 0, flags.includes("decline_burst"), now);
    return { ...d, transactionId: t.id, approvalId, mandate, settlement, holdExpiresAt, flags, shadow };
  });

  // Notify only once the request is durably recorded. Callers with a hard
  // deadline (Stripe gives a card authorisation two seconds) pass
  // `background` and get their answer before any channel is contacted.
  let notified = false;
  const sideEffects = async () => {
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
  };
  if (extra.background) extra.background(() => sideEffects().catch((e) => console.error("authorize side effects failed:", (e as Error).message)));
  else await sideEffects();
  const { mandate: _m, ...rest } = result;
  void _m;
  return { ...rest, notified } as AuthResult;
}

// ---------- Settlement: capture and void ----------

export type SettleResult =
  | { ok: true; transaction: Transaction; released: number }
  | { ok: false; code: "not_found" | "not_held" | "bad_amount"; message: string; transaction?: Transaction };

async function loadHeld(tx: Tx, mandateId: string | null, workspaceId: string | null, transactionId: string) {
  const [t] = await tx.select().from(transactions).where(and(eq(transactions.id, transactionId), mandateId ? eq(transactions.mandateId, mandateId) : undefined, workspaceId ? eq(transactions.workspaceId, workspaceId) : undefined)).for("update").limit(1);
  return t ?? null;
}

function notHeld(t: Transaction): SettleResult {
  const state = t.decision !== "approved" ? `was ${t.decision}, so there is nothing to settle` : `is already ${t.settlement}`;
  return { ok: false, code: "not_held", message: `This authorisation ${state}.`, transaction: t };
}

// The agent (or the owner) says what was actually paid. Capturing less than
// was authorised gives the difference back to the limits; capturing more is
// refused — a bigger purchase is a new authorisation. One capture closes
// the hold.
export async function captureTransaction(scope: { mandateId?: string; workspaceId?: string }, transactionId: string, opts: { amount?: number; by: string; note?: string }): Promise<SettleResult> {
  const now = new Date();
  return db.transaction(async (tx): Promise<SettleResult> => {
    const t = await loadHeld(tx, scope.mandateId ?? null, scope.workspaceId ?? null, transactionId);
    if (!t) return { ok: false, code: "not_found", message: "No such authorisation under this mandate." };
    if (t.decision !== "approved" || t.settlement !== "held") return notHeld(t);
    const authorized = t.authorizedAmount ?? t.amount;
    const captured = opts.amount ?? authorized;
    if (!Number.isInteger(captured) || captured <= 0 || captured > authorized) return { ok: false, code: "bad_amount", message: `Capture amount must be a positive integer no greater than the authorised ${authorized}.`, transaction: t };
    const released = authorized - captured;
    const note = (opts.note ?? "").trim().slice(0, 300) || null;
    const [updated] = await tx.update(transactions).set({ amount: captured, settlement: "captured", settledAt: now, settledBy: opts.by.slice(0, 120), settlementNote: note }).where(eq(transactions.id, t.id)).returning();
    await appendEvent(tx, t.workspaceId, "authorization.captured", { transactionId: t.id, mandateId: t.mandateId, authorizedAmount: authorized, capturedAmount: captured, released, currency: t.currency, merchant: t.merchant, by: opts.by, note });
    return { ok: true, transaction: updated, released };
  });
}

// Nothing was paid: the whole hold goes back to the limits.
export async function voidTransaction(scope: { mandateId?: string; workspaceId?: string }, transactionId: string, opts: { by: string; reason?: string }): Promise<SettleResult> {
  const now = new Date();
  return db.transaction(async (tx): Promise<SettleResult> => {
    const t = await loadHeld(tx, scope.mandateId ?? null, scope.workspaceId ?? null, transactionId);
    if (!t) return { ok: false, code: "not_found", message: "No such authorisation under this mandate." };
    if (t.decision !== "approved" || t.settlement !== "held") return notHeld(t);
    const authorized = t.authorizedAmount ?? t.amount;
    const reason = (opts.reason ?? "").trim().slice(0, 300) || null;
    const [updated] = await tx.update(transactions).set({ amount: 0, settlement: "voided", settledAt: now, settledBy: opts.by.slice(0, 120), settlementNote: reason }).where(eq(transactions.id, t.id)).returning();
    await appendEvent(tx, t.workspaceId, "authorization.voided", { transactionId: t.id, mandateId: t.mandateId, authorizedAmount: authorized, released: authorized, currency: t.currency, merchant: t.merchant, by: opts.by, reason });
    return { ok: true, transaction: updated, released: authorized };
  });
}

export async function getTransaction(scope: { mandateId?: string; workspaceId?: string }, transactionId: string): Promise<Transaction | null> {
  const [t] = await db.select().from(transactions).where(and(eq(transactions.id, transactionId), scope.mandateId ? eq(transactions.mandateId, scope.mandateId) : undefined, scope.workspaceId ? eq(transactions.workspaceId, scope.workspaceId) : undefined)).limit(1);
  return t ?? null;
}

// Open holds on a mandate, oldest first — what the owner sees as "held".
export async function openHolds(workspaceId: string, mandateId?: string) {
  return db.select().from(transactions).where(and(eq(transactions.workspaceId, workspaceId), eq(transactions.settlement, "held"), mandateId ? eq(transactions.mandateId, mandateId) : undefined)).orderBy(transactions.createdAt);
}

// What the agent is told about a settled or open authorisation.
export function settlementView(t: Transaction) {
  const authorized = t.authorizedAmount ?? t.amount;
  return {
    transactionId: t.id, decision: t.decision, settlement: t.settlement, authorizedAmount: authorized,
    capturedAmount: t.settlement === "captured" ? t.amount : t.settlement === "held" ? null : 0,
    released: t.settlement === "held" ? 0 : authorized - t.amount,
    currency: t.currency, merchant: t.merchant, purpose: t.purpose,
    holdExpiresAt: t.holdExpiresAt ? new Date(t.holdExpiresAt).toISOString() : null,
    settledAt: t.settledAt ? new Date(t.settledAt).toISOString() : null, settledBy: t.settledBy, note: t.settlementNote,
    createdAt: new Date(t.createdAt).toISOString(),
  };
}

// A card authorisation Stripe ended up declining on its side (or that timed
// out) must not count as spend: mark the approved transaction void.
export async function voidTransactionByStripeAuthorization(stripeAuthorizationId: string, reason: string) {
  const [t] = await db.select().from(transactions).where(and(eq(transactions.stripeAuthorizationId, stripeAuthorizationId), eq(transactions.decision, "approved"))).limit(1);
  if (!t || t.settlement === "voided") return null;
  await db.transaction(async (tx) => {
    await tx.update(transactions).set({ amount: 0, settlement: "voided", settledAt: new Date(), settledBy: "stripe", settlementNote: `Voided: ${reason}`.slice(0, 300) }).where(eq(transactions.id, t.id));
    await appendEvent(tx, t.workspaceId, "authorization.voided", { transactionId: t.id, mandateId: t.mandateId, authorizedAmount: t.authorizedAmount ?? t.amount, released: t.amount, currency: t.currency, merchant: t.merchant, stripeAuthorizationId, by: "stripe", reason });
  });
  return t;
}

// ---------- Idempotency ----------

// Idempotency in three steps so two concurrent retries with the same key can
// never both reach the policy engine: reserve the key (status 0) before
// deciding; complete it with the stored answer once the outcome is terminal;
// release it when the outcome is "pending", so the next retry re-evaluates
// and picks up the approval instead of replaying "pending" forever.
export type IdemReservation =
  | { kind: "reserved" }
  | { kind: "replay"; status: number; response: string }
  | { kind: "in_progress" };

export async function reserveIdempotent(mandateId: string, key: string): Promise<IdemReservation> {
  const id = `${mandateId}:${key}`;
  const inserted = await db.insert(idempotencyKeys).values({ id, mandateId, status: 0, response: "", createdAt: new Date() }).onConflictDoNothing().returning({ id: idempotencyKeys.id });
  if (inserted.length) return { kind: "reserved" };
  const [row] = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.id, id)).limit(1);
  if (!row) return { kind: "reserved" }; // released between our insert and select; treat as fresh
  if (row.status === 0) {
    // A reservation older than a minute belongs to a request that crashed; take it over.
    if (Date.now() - row.createdAt.getTime() > 60_000) {
      const took = await db.update(idempotencyKeys).set({ createdAt: new Date() }).where(and(eq(idempotencyKeys.id, id), eq(idempotencyKeys.createdAt, row.createdAt), eq(idempotencyKeys.status, 0))).returning({ id: idempotencyKeys.id });
      return took.length ? { kind: "reserved" } : { kind: "in_progress" };
    }
    return { kind: "in_progress" };
  }
  return { kind: "replay", status: row.status, response: row.response };
}

export async function completeIdempotent(mandateId: string, key: string, status: number, response: unknown) {
  await db.update(idempotencyKeys).set({ status, response: JSON.stringify(response) }).where(eq(idempotencyKeys.id, `${mandateId}:${key}`));
}

export async function releaseIdempotent(mandateId: string, key: string) {
  await db.delete(idempotencyKeys).where(and(eq(idempotencyKeys.id, `${mandateId}:${key}`), eq(idempotencyKeys.status, 0)));
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

export type HumanSignature = { credentialId: string; alg: number; challenge: string; clientDataJSON: string; authenticatorData: string; signature: string; publicKey: string; userId: string; verifiedAt: string };

export async function decideApproval(workspaceId: string | null, id: string, decision: "approved" | "denied", by: string, signed?: HumanSignature) {
  const now = new Date();
  return db.transaction(async (tx) => {
    const [a] = await tx.select().from(approvals).where(eq(approvals.id, id)).for("update").limit(1);
    if (!a || (workspaceId && a.workspaceId !== workspaceId)) return null;
    const r = await tx.update(approvals)
      .set({ status: decision, decidedAt: now, decidedBy: by, expiresAt: decision === "approved" ? new Date(now.getTime() + ALLOWANCE_TTL_MS) : null, signedWith: signed?.credentialId ?? null, signature: signed ? JSON.stringify(signed) : null })
      .where(and(eq(approvals.id, id), eq(approvals.status, "pending"))).returning({ id: approvals.id });
    if (r.length === 0) return null;
    await appendEvent(tx, a.workspaceId, `approval.${decision}`, {
      approvalId: id, mandateId: a.mandateId, amount: a.amount, currency: a.currency, merchant: a.merchant, by, validForMs: decision === "approved" ? ALLOWANCE_TTL_MS : null, kind: a.kind,
      humanSigned: signed ? { credentialId: signed.credentialId, alg: signed.alg, challenge: signed.challenge, signatureSha256: createHash("sha256").update(signed.signature).digest("hex") } : undefined,
    });
    // A denial is the owner saying "no": earned autonomy steps back down.
    if (decision === "denied") {
      const [m] = await tx.select().from(mandates).where(eq(mandates.id, a.mandateId)).for("update").limit(1);
      if (m && m.autonomyStep > 0) await autonomyTick(tx, m, false, true, now);
    }
    return { ...a, status: decision };
  });
}

// ---------- Graduated autonomy ----------

// Clean decision → streak; streak reaches `every` → level += step (up to the
// ceiling). Anything that looks like trouble (a denial, a decline burst)
// → level −= step, streak reset. Every change is a ledger event.
async function autonomyTick(tx: Tx, m: Mandate, clean: boolean, trouble: boolean, now: Date) {
  const maxLevel = Math.max(0, (m.autonomyCeiling ?? m.perTxnLimit) - m.perTxnLimit);
  if (trouble) {
    if (m.autonomyLevel === 0 && m.autonomyStreak === 0) return;
    const level = Math.max(0, m.autonomyLevel - m.autonomyStep);
    await tx.update(mandates).set({ autonomyLevel: level, autonomyStreak: 0 }).where(eq(mandates.id, m.id));
    await appendEvent(tx, m.workspaceId, "mandate.autonomy_down", { mandateId: m.id, from: m.autonomyLevel, to: level, currency: m.currency, perTxnNow: m.perTxnLimit + level, reason: "denial or decline burst", at: now.toISOString() });
    return;
  }
  if (!clean) return;
  const streak = m.autonomyStreak + 1;
  if (streak >= m.autonomyEvery && m.autonomyLevel < maxLevel) {
    const level = Math.min(maxLevel, m.autonomyLevel + m.autonomyStep);
    await tx.update(mandates).set({ autonomyLevel: level, autonomyStreak: 0 }).where(eq(mandates.id, m.id));
    await appendEvent(tx, m.workspaceId, "mandate.autonomy_up", { mandateId: m.id, from: m.autonomyLevel, to: level, currency: m.currency, perTxnNow: m.perTxnLimit + level, ceiling: m.autonomyCeiling, after: m.autonomyEvery });
  } else {
    await tx.update(mandates).set({ autonomyStreak: m.autonomyLevel >= maxLevel ? 0 : streak }).where(eq(mandates.id, m.id));
  }
}

export async function resetAutonomy(workspaceId: string, id: string, by: string) {
  await db.transaction(async (tx) => {
    const r = await tx.update(mandates).set({ autonomyLevel: 0, autonomyStreak: 0 }).where(and(eq(mandates.id, id), eq(mandates.workspaceId, workspaceId))).returning({ id: mandates.id });
    if (r.length) await appendEvent(tx, workspaceId, "mandate.autonomy_down", { mandateId: id, to: 0, reason: "reset by " + by, by });
  });
}

// ---------- Shadow mode ----------

export async function setMandateMode(workspaceId: string, id: string, mode: "enforce" | "observe", by: string) {
  await db.transaction(async (tx) => {
    const r = await tx.update(mandates).set({ mode }).where(and(eq(mandates.id, id), eq(mandates.workspaceId, workspaceId), sql`${mandates.mode} <> ${mode}`)).returning({ id: mandates.id });
    if (r.length) await appendEvent(tx, workspaceId, "mandate.mode_changed", { mandateId: id, mode, by });
  });
}

export type ShadowReport = { total: number; wouldDecline: number; wouldAsk: number; byRule: { rule: string; count: number }[]; rows: Transaction[] };

// What the terms would have done while the mandate was observing.
export async function shadowReport(workspaceId: string, mandateId: string, limit = 200): Promise<ShadowReport> {
  const rows = await db.select().from(transactions).where(and(eq(transactions.workspaceId, workspaceId), eq(transactions.mandateId, mandateId), sql`${transactions.shadowDecision} is not null`)).orderBy(desc(transactions.createdAt)).limit(limit);
  const byRule = new Map<string, number>();
  for (const r of rows) if (r.shadowDecision !== "approved") byRule.set(r.shadowRule ?? "?", (byRule.get(r.shadowRule ?? "?") ?? 0) + 1);
  return { total: rows.length, wouldDecline: rows.filter((r) => r.shadowDecision === "declined").length, wouldAsk: rows.filter((r) => r.shadowDecision === "pending").length, byRule: [...byRule].map(([rule, count]) => ({ rule, count })).sort((a, b) => b.count - a.count), rows: rows.filter((r) => r.shadowDecision !== "approved") };
}

// ---------- Plans ----------

export const PLAN_TTL_MS = 7 * 24 * 3600_000;
export const PLAN_MAX_ITEMS = 25;

export type PlanInput = { title: string; items: { merchant: string; amount: number; purpose?: string }[]; proposedBy?: string; source?: Source };
export type PlanResult = { ok: true; plan: Plan } | { ok: false; error: string };

export async function proposePlan(m: Mandate, input: PlanInput): Promise<PlanResult> {
  const title = input.title.trim().slice(0, 120);
  if (!title) return { ok: false, error: "Give the plan a title the owner will understand." };
  if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > PLAN_MAX_ITEMS) return { ok: false, error: `A plan lists 1–${PLAN_MAX_ITEMS} items.` };
  const items: PlanItem[] = [];
  for (const it of input.items) {
    const merchant = String(it.merchant ?? "").trim().slice(0, 120);
    if (!merchant || !Number.isInteger(it.amount) || it.amount <= 0 || it.amount > MAX_AMOUNT) return { ok: false, error: "Each item needs a merchant and a positive integer amount in minor units." };
    if (it.amount > m.perTxnLimit) return { ok: false, error: `Item at ${merchant}: ${it.amount} exceeds the mandate's per-transaction limit of ${m.perTxnLimit}. A plan cannot pre-approve what the terms forbid.` };
    items.push({ merchant, amount: it.amount, purpose: String(it.purpose ?? "").trim().slice(0, 200) || undefined, usedBy: null });
  }
  const totalMax = items.reduce((s, it) => s + it.amount, 0);
  const [open] = await db.select({ c: sql<number>`count(*)::int` }).from(schema.plans).where(and(eq(schema.plans.mandateId, m.id), eq(schema.plans.status, "proposed")));
  if (Number(open?.c ?? 0) >= 3) return { ok: false, error: "Three plans are already waiting for the owner on this mandate." };
  const now = new Date();
  const row: Plan = { id: randomUUID(), workspaceId: m.workspaceId, mandateId: m.id, title, items: JSON.stringify(items), totalMax, currency: m.currency, status: "proposed", proposedBy: (input.proposedBy ?? "").slice(0, 120), source: input.source ?? "agent_api", flags: "[]", createdAt: now, decidedAt: null, decidedBy: null, expiresAt: new Date(now.getTime() + PLAN_TTL_MS) };
  await db.transaction(async (tx) => {
    await tx.insert(schema.plans).values(row);
    await appendEvent(tx, m.workspaceId, "plan.proposed", { planId: row.id, mandateId: m.id, title, items: items.map((it) => ({ merchant: it.merchant, amount: it.amount, purpose: it.purpose })), totalMax, currency: m.currency, proposedBy: row.proposedBy, source: row.source });
  });
  return { ok: true, plan: row };
}

export async function decidePlan(workspaceId: string | null, id: string, decision: "approved" | "denied", by: string) {
  const now = new Date();
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(schema.plans).where(eq(schema.plans.id, id)).for("update").limit(1);
    if (!p || (workspaceId && p.workspaceId !== workspaceId) || p.status !== "proposed") return null;
    await tx.update(schema.plans).set({ status: decision, decidedAt: now, decidedBy: by, expiresAt: decision === "approved" ? new Date(now.getTime() + PLAN_TTL_MS) : p.expiresAt }).where(eq(schema.plans.id, id));
    await appendEvent(tx, p.workspaceId, `plan.${decision}`, { planId: id, mandateId: p.mandateId, title: p.title, totalMax: p.totalMax, currency: p.currency, by, validForMs: decision === "approved" ? PLAN_TTL_MS : null });
    return { ...p, status: decision };
  });
}

export async function cancelPlan(workspaceId: string, id: string, by: string) {
  await db.transaction(async (tx) => {
    const r = await tx.update(schema.plans).set({ status: "cancelled", decidedAt: new Date(), decidedBy: by }).where(and(eq(schema.plans.id, id), eq(schema.plans.workspaceId, workspaceId), sql`${schema.plans.status} in ('proposed','approved')`)).returning({ mandateId: schema.plans.mandateId, title: schema.plans.title });
    if (r.length) await appendEvent(tx, workspaceId, "plan.cancelled", { planId: id, mandateId: r[0].mandateId, title: r[0].title, by });
  });
}

export async function getPlan(scope: { mandateId?: string; workspaceId?: string }, id: string): Promise<Plan | null> {
  const [p] = await db.select().from(schema.plans).where(and(eq(schema.plans.id, id), scope.mandateId ? eq(schema.plans.mandateId, scope.mandateId) : undefined, scope.workspaceId ? eq(schema.plans.workspaceId, scope.workspaceId) : undefined)).limit(1);
  return p ?? null;
}

export async function listPlans(workspaceId: string, opts: { mandateId?: string; status?: string } = {}) {
  await sweep(workspaceId);
  return db.select({ p: schema.plans, mandateName: mandates.name, agentName: agents.name }).from(schema.plans)
    .innerJoin(mandates, eq(mandates.id, schema.plans.mandateId)).innerJoin(agents, eq(agents.id, mandates.agentId))
    .where(and(eq(schema.plans.workspaceId, workspaceId), opts.mandateId ? eq(schema.plans.mandateId, opts.mandateId) : undefined, opts.status ? eq(schema.plans.status, opts.status) : undefined))
    .orderBy(desc(schema.plans.createdAt)).limit(100);
}

export function planView(p: Plan) {
  const items = parsePlanItems(p.items);
  return { planId: p.id, title: p.title, status: p.status, currency: p.currency, totalMax: p.totalMax, items: items.map((it, i) => ({ index: i, merchant: it.merchant, amount: it.amount, purpose: it.purpose ?? "", used: Boolean(it.usedBy), transactionId: it.usedBy && it.usedBy !== "pending" ? it.usedBy : null })), createdAt: new Date(p.createdAt).toISOString(), decidedAt: p.decidedAt ? new Date(p.decidedAt).toISOString() : null, decidedBy: p.decidedBy, expiresAt: p.expiresAt ? new Date(p.expiresAt).toISOString() : null };
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
// Card lifecycle after the authorisation: captures arrive one per
// issuing_transaction (a merchant may capture in parts), so they accumulate;
// a reversal or an authorisation closed without any capture releases the
// hold; a refund is a negative approved transaction so sums net down.
export async function reconcileCard(stripeAuthorizationId: string, kind: "capture" | "reversal" | "refund" | "closed", amount: number, ref: string, at: Date = new Date()) {
  const [t0] = await db.select({ id: transactions.id }).from(transactions).where(eq(transactions.stripeAuthorizationId, stripeAuthorizationId)).limit(1);
  if (!t0) return false;
  await db.transaction(async (tx) => {
    // Lock the row: two capture webhooks for one authorisation must add up.
    const [t] = await tx.select().from(transactions).where(eq(transactions.id, t0.id)).for("update").limit(1);
    const [prior] = await tx.select({ c: sql<number>`count(*)::int` }).from(schema.ledger)
      .where(and(eq(schema.ledger.workspaceId, t.workspaceId), eq(schema.ledger.type, "stripe.capture"), sql`${schema.ledger.payload} like ${'%"stripeAuthorizationId":"' + stripeAuthorizationId + '"%'}`));
    const captures = Number(prior?.c ?? 0);
    const authorized = t.authorizedAmount ?? t.amount;
    if (kind === "capture") {
      // Card captures arrive in parts and can keep coming; the row stays
      // "captured" from the first one, with the amount accumulating.
      const total = captures === 0 ? amount : t.amount + amount;
      await tx.update(transactions).set({ amount: total, settlement: "captured", settledAt: at, settledBy: "stripe", settlementNote: captures === 0 ? `Captured ${amount} of ${authorized} authorised.` : `Captured ${amount} more; ${total} in total.` }).where(eq(transactions.id, t.id));
    } else if (kind === "reversal") {
      await tx.update(transactions).set({ amount: 0, settlement: "voided", settledAt: at, settledBy: "stripe", settlementNote: "Authorisation reversed by the network; nothing charged." }).where(eq(transactions.id, t.id));
    } else if (kind === "closed") {
      if (captures === 0) await tx.update(transactions).set({ amount: 0, settlement: "released", settledAt: at, settledBy: "stripe", settlementNote: "Authorisation closed without capture; hold released." }).where(eq(transactions.id, t.id));
    } else {
      await tx.insert(transactions).values({ id: randomUUID(), workspaceId: t.workspaceId, mandateId: t.mandateId, amount: -Math.abs(amount), currency: t.currency, merchant: t.merchant, category: t.category, purpose: `Refund of ${t.purpose || "card purchase"}`, decision: "approved", reason: "Refund from merchant.", source: "stripe", actor: t.actor, stripeAuthorizationId: null, approvalId: null, authorizedAmount: -Math.abs(amount), settlement: "captured", holdExpiresAt: null, settledAt: at, settledBy: "stripe", settlementNote: "Refund from merchant.", createdAt: at });
    }
    await appendEvent(tx, t.workspaceId, `stripe.${kind}`, { transactionId: t.id, mandateId: t.mandateId, stripeAuthorizationId, amount, ref, at: at.toISOString() });
  });
  return true;
}

// ---------- Lifecycle: leaving, deleting, exporting ----------

// Everything a workspace owns, removed in dependency order. Used when an
// owner deletes a workspace and when the last owner deletes their account.
// Cards live at Stripe: cancel them before the rows go, so nothing can be
// charged to a workspace that no longer exists. Errors are logged, never
// fatal — the webhook fails closed for an unknown card anyway.
export async function cancelWorkspaceCards(workspaceId: string) {
  const { stripeEnabled, deactivateCard } = await import("./stripe");
  if (!stripeEnabled()) return;
  const rows = await db.select({ id: mandates.id, cardId: mandates.stripeCardId }).from(mandates).where(and(eq(mandates.workspaceId, workspaceId), sql`${mandates.stripeCardId} is not null`));
  for (const r of rows) { try { await deactivateCard(r.cardId!); } catch (e) { console.error(`could not cancel card ${r.cardId}: ${(e as Error).message}`); } }
}

// ---------- Sharing a decision's receipt ----------

export async function shareTransaction(workspaceId: string, transactionId: string, by: string): Promise<string | null> {
  const token = randomBytes(18).toString("base64url");
  return db.transaction(async (tx) => {
    const [t] = await tx.select({ id: transactions.id, mandateId: transactions.mandateId, shareToken: transactions.shareToken }).from(transactions).where(and(eq(transactions.id, transactionId), eq(transactions.workspaceId, workspaceId))).limit(1);
    if (!t) return null;
    if (t.shareToken) return t.shareToken;
    await tx.update(transactions).set({ shareToken: token }).where(eq(transactions.id, t.id));
    await appendEvent(tx, workspaceId, "receipt.shared", { transactionId: t.id, mandateId: t.mandateId, by });
    return token;
  });
}

export async function unshareTransaction(workspaceId: string, transactionId: string, by: string) {
  await db.transaction(async (tx) => {
    const r = await tx.update(transactions).set({ shareToken: null }).where(and(eq(transactions.id, transactionId), eq(transactions.workspaceId, workspaceId), sql`${transactions.shareToken} is not null`)).returning({ mandateId: transactions.mandateId });
    if (r.length) await appendEvent(tx, workspaceId, "receipt.unshared", { transactionId, mandateId: r[0].mandateId, by });
  });
}

// ---------- Workspace settings ----------

export async function getWorkspaceSettings(workspaceId: string): Promise<{ currency: string }> {
  const [s] = await db.select().from(schema.workspaceSettings).where(eq(schema.workspaceSettings.workspaceId, workspaceId)).limit(1);
  return { currency: s?.currency ?? "USD" };
}

export async function saveWorkspaceSettings(workspaceId: string, input: { currency: string }, by: string) {
  const currency = input.currency.toUpperCase();
  if (!isCurrencyCode(currency)) throw new Error("Currency must be a 3-letter ISO code.");
  await db.transaction(async (tx) => {
    await tx.insert(schema.workspaceSettings).values({ workspaceId, currency, updatedAt: new Date() }).onConflictDoUpdate({ target: schema.workspaceSettings.workspaceId, set: { currency, updatedAt: new Date() } });
    await appendEvent(tx, workspaceId, "workspace.settings_changed", { currency, by });
  });
}

export async function purgeWorkspace(tx: Tx, workspaceId: string) {
  await tx.delete(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.workspaceId, workspaceId));
  await tx.delete(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.workspaceId, workspaceId));
  await tx.delete(schema.notes).where(eq(schema.notes.workspaceId, workspaceId));
  await tx.delete(schema.workspaceSettings).where(eq(schema.workspaceSettings.workspaceId, workspaceId));
  await tx.delete(schema.proxyCalls).where(eq(schema.proxyCalls.workspaceId, workspaceId));
  await tx.delete(schema.proxyKeys).where(eq(schema.proxyKeys.workspaceId, workspaceId));
  await tx.delete(schema.providerKeys).where(eq(schema.providerKeys.workspaceId, workspaceId));
  await tx.delete(schema.idempotencyKeys).where(sql`${schema.idempotencyKeys.mandateId} in (select id from mandates where workspace_id = ${workspaceId})`);
  await tx.delete(transactions).where(eq(transactions.workspaceId, workspaceId));
  await tx.delete(approvals).where(eq(approvals.workspaceId, workspaceId));
  await tx.delete(mandates).where(eq(mandates.workspaceId, workspaceId));
  await tx.delete(agents).where(eq(agents.workspaceId, workspaceId));
  await tx.delete(schema.cardholderProfiles).where(eq(schema.cardholderProfiles.workspaceId, workspaceId));
  await tx.delete(schema.ledgerHeads).where(eq(schema.ledgerHeads.workspaceId, workspaceId));
  await tx.delete(schema.ledger).where(eq(schema.ledger.workspaceId, workspaceId));
  await tx.delete(schema.invitation).where(eq(schema.invitation.organizationId, workspaceId));
  await tx.delete(schema.member).where(eq(schema.member.organizationId, workspaceId));
  await tx.delete(schema.organization).where(eq(schema.organization.id, workspaceId));
}

export async function deleteWorkspace(workspaceId: string, byUserId: string) {
  await cancelWorkspaceCards(workspaceId);
  await db.transaction(async (tx) => {
    const [m] = await tx.select({ role: schema.member.role }).from(schema.member).where(and(eq(schema.member.organizationId, workspaceId), eq(schema.member.userId, byUserId))).limit(1);
    if (!m || !/\bowner\b/.test(m.role)) throw new Error("Only an owner can delete a workspace.");
    await purgeWorkspace(tx, workspaceId);
  });
}

// Workspaces where this user is the only owner: deleting the account deletes
// them too (there would be nobody left to hold the authority).
export async function soleOwnedWorkspaces(userId: string): Promise<{ id: string; name: string; otherMembers: number }[]> {
  const mine = await db.select({ orgId: schema.member.organizationId, role: schema.member.role, name: schema.organization.name }).from(schema.member)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId)).where(eq(schema.member.userId, userId));
  const out: { id: string; name: string; otherMembers: number }[] = [];
  for (const m of mine) {
    if (!/\bowner\b/.test(m.role)) continue;
    const others = await db.select({ role: schema.member.role }).from(schema.member).where(and(eq(schema.member.organizationId, m.orgId), sql`${schema.member.userId} <> ${userId}`));
    if (!others.some((o) => /\bowner\b/.test(o.role))) out.push({ id: m.orgId, name: m.name, otherMembers: others.length });
  }
  return out;
}

export async function deleteAccount(userId: string) {
  for (const w of await soleOwnedWorkspaces(userId)) await cancelWorkspaceCards(w.id);
  await db.transaction(async (tx) => {
    const sole = await soleOwnedWorkspaces(userId);
    for (const w of sole) await purgeWorkspace(tx, w.id);
    await tx.delete(schema.member).where(eq(schema.member.userId, userId));
    await tx.delete(schema.notificationChannels).where(eq(schema.notificationChannels.userId, userId));
    // sessions, accounts, passkeys, OAuth tokens and consents cascade from the user row
    await tx.delete(schema.user).where(eq(schema.user.id, userId));
  });
}

// Everything the person can see about themselves and their workspaces, as JSON.
export async function exportAccount(userId: string) {
  const [u] = await db.select({ id: schema.user.id, email: schema.user.email, name: schema.user.name, createdAt: schema.user.createdAt }).from(schema.user).where(eq(schema.user.id, userId)).limit(1);
  const memberships = await db.select({ workspaceId: schema.member.organizationId, role: schema.member.role, name: schema.organization.name }).from(schema.member)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId)).where(eq(schema.member.userId, userId));
  const channels = await db.select({ type: schema.notificationChannels.type, target: schema.notificationChannels.target, label: schema.notificationChannels.label }).from(schema.notificationChannels).where(eq(schema.notificationChannels.userId, userId));
  const workspaces = [];
  for (const m of memberships) {
    const ws = m.workspaceId;
    workspaces.push({
      id: ws, name: m.name, role: m.role,
      agents: await db.select().from(agents).where(eq(agents.workspaceId, ws)),
      mandates: (await db.select().from(mandates).where(eq(mandates.workspaceId, ws))).map(({ tokenHash: _h, tokenReveal: _r, ...rest }) => { void _h; void _r; return rest; }),
      transactions: await db.select().from(transactions).where(eq(transactions.workspaceId, ws)),
      approvals: await db.select().from(approvals).where(eq(approvals.workspaceId, ws)),
      ledger: await db.select().from(schema.ledger).where(eq(schema.ledger.workspaceId, ws)).orderBy(schema.ledger.seq),
    });
  }
  return { exportedAt: new Date().toISOString(), user: u, channels, workspaces };
}
