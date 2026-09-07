import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db, schema, type Tx } from "./db";
import { appendEvent, recordEvent } from "./ledger";
import { evaluate, localDayStart, validateTerms, ALLOWANCE_TTL_MS, DENIAL_COOLOFF_MS, type AuthRequest, type Decision, type Facts, type TermsError } from "./policy";
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
  const facts: Facts = { spentToday: Number(today?.s ?? 0), spentTotal: Number(total?.s ?? 0), approvedAllowances: allowances, openPending: Number(pend?.c ?? 0), recentlyDenied, availableBalance: null };
  return facts;
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
  return { ...rest, notified };
}

// A card authorisation Stripe ended up declining on its side (or that timed
// out) must not count as spend: mark the approved transaction void.
export async function voidTransactionByStripeAuthorization(stripeAuthorizationId: string, reason: string) {
  const [t] = await db.select().from(transactions).where(and(eq(transactions.stripeAuthorizationId, stripeAuthorizationId), eq(transactions.decision, "approved"))).limit(1);
  if (!t) return null;
  await db.transaction(async (tx) => {
    await tx.update(transactions).set({ decision: "voided", reason: `Voided: ${reason}` }).where(eq(transactions.id, t.id));
    await appendEvent(tx, t.workspaceId, "authorization.voided", { transactionId: t.id, mandateId: t.mandateId, amount: t.amount, currency: t.currency, merchant: t.merchant, stripeAuthorizationId, reason });
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
    if (kind === "capture") {
      const total = captures === 0 ? amount : t.amount + amount;
      await tx.update(transactions).set({ amount: total, reason: captures === 0 ? `Captured ${amount} of ${t.amount} authorised.` : `Captured ${amount} more; ${total} in total.` }).where(eq(transactions.id, t.id));
    } else if (kind === "reversal") {
      await tx.update(transactions).set({ amount: 0, reason: "Authorisation reversed by the network; nothing charged." }).where(eq(transactions.id, t.id));
    } else if (kind === "closed") {
      if (captures === 0) await tx.update(transactions).set({ amount: 0, reason: "Authorisation closed without capture; hold released." }).where(eq(transactions.id, t.id));
    } else {
      await tx.insert(transactions).values({ id: randomUUID(), workspaceId: t.workspaceId, mandateId: t.mandateId, amount: -Math.abs(amount), currency: t.currency, merchant: t.merchant, category: t.category, purpose: `Refund of ${t.purpose || "card purchase"}`, decision: "approved", reason: "Refund from merchant.", source: "stripe", actor: t.actor, stripeAuthorizationId: null, approvalId: null, createdAt: at });
    }
    await appendEvent(tx, t.workspaceId, `stripe.${kind}`, { transactionId: t.id, mandateId: t.mandateId, stripeAuthorizationId, amount, ref, at: at.toISOString() });
  });
  return true;
}

// ---------- Lifecycle: leaving, deleting, exporting ----------

// Everything a workspace owns, removed in dependency order. Used when an
// owner deletes a workspace and when the last owner deletes their account.
export async function purgeWorkspace(tx: Tx, workspaceId: string) {
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
