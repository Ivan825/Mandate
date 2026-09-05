import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db, schema } from "./db";
import { appendEvent } from "./ledger";
import { evaluate, localDayStart, type AuthRequest, type Decision } from "./policy";
import type { Mandate, Approval, Transaction } from "./schema";

const { agents, mandates, transactions, approvals } = schema;

export function newToken(): string {
  return "mnd_" + randomBytes(18).toString("base64url");
}

// ---------- Agents ----------

export async function createAgent(input: { name: string; description?: string }) {
  const row = { id: randomUUID(), name: input.name.trim(), description: (input.description ?? "").trim(), createdAt: new Date() };
  await db.insert(agents).values(row);
  await appendEvent("agent.created", { agentId: row.id, name: row.name });
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

export async function createMandate(input: MandateInput): Promise<Mandate> {
  const row: Mandate = {
    id: randomUUID(),
    agentId: input.agentId,
    name: input.name.trim(),
    status: "active",
    currency: input.currency.toUpperCase(),
    perTxnLimit: input.perTxnLimit,
    dailyLimit: input.dailyLimit,
    totalLimit: input.totalLimit,
    approvalAbove: input.approvalAbove,
    allowedMerchants: JSON.stringify(input.allowedMerchants.map((s) => s.trim()).filter(Boolean)),
    blockedCategories: JSON.stringify(input.blockedCategories.map((s) => s.trim()).filter(Boolean)),
    activeHoursStart: input.activeHoursStart,
    activeHoursEnd: input.activeHoursEnd,
    timezone: input.timezone,
    expiresAt: input.expiresAt,
    token: newToken(),
    stripeCardholderId: null,
    stripeCardId: null,
    cardLast4: null,
    createdAt: new Date(),
    revokedAt: null,
  };
  await db.insert(mandates).values(row);
  await appendEvent("mandate.issued", {
    mandateId: row.id, agentId: row.agentId, name: row.name, currency: row.currency,
    perTxnLimit: row.perTxnLimit, dailyLimit: row.dailyLimit, totalLimit: row.totalLimit,
    approvalAbove: row.approvalAbove, allowedMerchants: JSON.parse(row.allowedMerchants),
    activeHours: [row.activeHoursStart, row.activeHoursEnd], timezone: row.timezone,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
  });
  return row;
}

export async function attachCard(mandateId: string, card: { cardholderId: string; cardId: string; last4: string }) {
  await db.update(mandates).set({ stripeCardholderId: card.cardholderId, stripeCardId: card.cardId, cardLast4: card.last4 }).where(eq(mandates.id, mandateId));
  await appendEvent("mandate.card_issued", { mandateId, cardId: card.cardId, last4: card.last4 });
}

export async function getMandate(id: string) {
  const [m] = await db.select().from(mandates).where(eq(mandates.id, id)).limit(1);
  return m ?? null;
}

export async function getMandateByToken(token: string) {
  const [m] = await db.select().from(mandates).where(eq(mandates.token, token)).limit(1);
  return m ?? null;
}

export async function getMandateByCard(cardId: string) {
  const [m] = await db.select().from(mandates).where(eq(mandates.stripeCardId, cardId)).limit(1);
  return m ?? null;
}

export async function revokeMandate(id: string, by = "owner") {
  await db.update(mandates).set({ status: "revoked", revokedAt: new Date() }).where(eq(mandates.id, id));
  await db.update(approvals).set({ status: "expired" }).where(and(eq(approvals.mandateId, id), eq(approvals.status, "pending")));
  await appendEvent("mandate.revoked", { mandateId: id, by });
}

// ---------- Facts & exposure ----------

export async function factsFor(m: Mandate, now = new Date()) {
  const dayStart = localDayStart(now, m.timezone);
  const [today] = await db
    .select({ s: sql<number>`coalesce(sum(${transactions.amount}), 0)` })
    .from(transactions)
    .where(and(eq(transactions.mandateId, m.id), eq(transactions.decision, "approved"), gte(transactions.createdAt, dayStart)));
  const [total] = await db
    .select({ s: sql<number>`coalesce(sum(${transactions.amount}), 0)` })
    .from(transactions)
    .where(and(eq(transactions.mandateId, m.id), eq(transactions.decision, "approved")));
  const allowances = await db.select().from(approvals).where(and(eq(approvals.mandateId, m.id), eq(approvals.status, "approved")));
  return { spentToday: Number(today?.s ?? 0), spentTotal: Number(total?.s ?? 0), approvedAllowances: allowances };
}

export type Exposure = {
  mandate: Mandate;
  agentName: string;
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
  const out: Exposure[] = [];
  for (const { m, agentName } of rows) {
    const f = await factsFor(m);
    const [pend] = await db.select({ c: sql<number>`count(*)` }).from(approvals).where(and(eq(approvals.mandateId, m.id), eq(approvals.status, "pending")));
    const dayStart = localDayStart(new Date(), m.timezone);
    const [decl] = await db.select({ c: sql<number>`count(*)` }).from(transactions).where(and(eq(transactions.mandateId, m.id), eq(transactions.decision, "declined"), gte(transactions.createdAt, dayStart)));
    const [last] = await db.select({ t: transactions.createdAt }).from(transactions).where(eq(transactions.mandateId, m.id)).orderBy(desc(transactions.createdAt)).limit(1);
    out.push({ mandate: m, agentName, spentToday: f.spentToday, spentTotal: f.spentTotal, pendingApprovals: Number(pend?.c ?? 0), declinedToday: Number(decl?.c ?? 0), lastActivity: last?.t ?? null });
  }
  return out;
}

// ---------- Authorisation ----------

export type AuthResult = Decision & { transactionId: string; approvalId?: string };

// The single path every purchase attempt goes through, regardless of source.
export async function authorize(m: Mandate, req: AuthRequest, source: "simulation" | "agent_api" | "stripe", extra: { stripeAuthorizationId?: string } = {}): Promise<AuthResult> {
  const now = req.now ?? new Date();
  const facts = await factsFor(m, now);
  const d = evaluate(m, req, facts);

  let approvalId: string | undefined;
  if (d.decision === "pending") {
    // Re-use an identical pending request rather than spamming the inbox.
    const [existing] = await db.select().from(approvals).where(and(
      eq(approvals.mandateId, m.id), eq(approvals.status, "pending"),
      eq(approvals.amount, Math.round(req.amount)), eq(approvals.merchant, req.merchant),
    )).limit(1);
    if (existing) approvalId = existing.id;
    else {
      const a: Approval = { id: randomUUID(), mandateId: m.id, amount: Math.round(req.amount), currency: m.currency, merchant: req.merchant, purpose: req.purpose ?? "", status: "pending", requestedAt: now, decidedAt: null, usedAt: null };
      await db.insert(approvals).values(a);
      approvalId = a.id;
      await appendEvent("approval.requested", { approvalId: a.id, mandateId: m.id, amount: a.amount, currency: a.currency, merchant: a.merchant, purpose: a.purpose });
    }
  }
  if (d.decision === "approved" && d.allowanceId) {
    await db.update(approvals).set({ status: "used", usedAt: now }).where(eq(approvals.id, d.allowanceId));
    approvalId = d.allowanceId;
  }

  const t: Transaction = {
    id: randomUUID(), mandateId: m.id, amount: Math.round(req.amount), currency: m.currency,
    merchant: req.merchant, category: req.category ?? "", purpose: req.purpose ?? "",
    decision: d.decision, reason: d.reason, source, stripeAuthorizationId: extra.stripeAuthorizationId ?? null,
    approvalId: d.decision === "approved" ? approvalId ?? null : null, createdAt: now,
  };
  await db.insert(transactions).values(t);
  await appendEvent(`authorization.${d.decision}`, {
    transactionId: t.id, mandateId: m.id, agentId: m.agentId, amount: t.amount, currency: t.currency,
    merchant: t.merchant, purpose: t.purpose, rule: d.rule, reason: d.reason, source,
    approvalId: approvalId ?? null, stripeAuthorizationId: t.stripeAuthorizationId,
  });
  return { ...d, transactionId: t.id, approvalId };
}

// ---------- Approvals ----------

export async function listApprovals(status?: string) {
  const q = db
    .select({ a: approvals, mandateName: mandates.name, agentName: agents.name })
    .from(approvals)
    .innerJoin(mandates, eq(mandates.id, approvals.mandateId))
    .innerJoin(agents, eq(agents.id, mandates.agentId))
    .orderBy(desc(approvals.requestedAt));
  const rows = await q;
  return status ? rows.filter((r) => r.a.status === status) : rows;
}

export async function decideApproval(id: string, decision: "approved" | "denied", by = "owner") {
  const [a] = await db.select().from(approvals).where(eq(approvals.id, id)).limit(1);
  if (!a || a.status !== "pending") return null;
  await db.update(approvals).set({ status: decision, decidedAt: new Date() }).where(eq(approvals.id, id));
  await appendEvent(`approval.${decision}`, { approvalId: id, mandateId: a.mandateId, amount: a.amount, currency: a.currency, merchant: a.merchant, by });
  return { ...a, status: decision };
}

// ---------- Activity ----------

export async function recentTransactions(limit = 25, mandateId?: string) {
  const rows = await db
    .select({ t: transactions, mandateName: mandates.name, agentName: agents.name })
    .from(transactions)
    .innerJoin(mandates, eq(mandates.id, transactions.mandateId))
    .innerJoin(agents, eq(agents.id, mandates.agentId))
    .where(mandateId ? eq(transactions.mandateId, mandateId) : undefined)
    .orderBy(desc(transactions.createdAt))
    .limit(limit);
  return rows;
}
