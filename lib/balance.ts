import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, schema, type Conn } from "./db";
import { appendEvent } from "./ledger";
import { issuingRegion } from "./stripe";

// The prepaid balance behind virtual cards. A card is paid for out of the
// operator's Stripe Issuing balance, so a workspace must have put money in
// first: card authorisations are declined the moment they would take the
// balance below zero, whatever the mandate's own limits allow.
//
//   available = top-ups + refunds − every approved card transaction
//
// Holds, captures, reversals and refunds all flow through the transactions
// table (see reconcileCard), so the balance needs no bookkeeping of its own.

export const MIN_TOPUP = 500;      // 5.00 in the issuing currency
export const MAX_TOPUP = 100_000;  // 1,000.00 per top-up, until you raise it

export function issuingCurrency(): string {
  return issuingRegion().currency;
}

export async function availableBalance(workspaceId: string, currency: string, conn: Conn = db): Promise<number> {
  const [t] = await conn.select({ s: sql<number>`coalesce(sum(${schema.topups.amount}), 0)::int` }).from(schema.topups)
    .where(and(eq(schema.topups.workspaceId, workspaceId), eq(schema.topups.currency, currency)));
  const [spent] = await conn.select({ s: sql<number>`coalesce(sum(${schema.transactions.amount}), 0)::int` }).from(schema.transactions)
    .where(and(eq(schema.transactions.workspaceId, workspaceId), eq(schema.transactions.currency, currency), eq(schema.transactions.source, "stripe"), eq(schema.transactions.decision, "approved")));
  return Number(t?.s ?? 0) - Number(spent?.s ?? 0);
}

// Serialises card decisions within a workspace so two cards cannot both
// spend the last dollar. Call inside a transaction, before reading the balance.
export async function lockBalance(tx: Conn, workspaceId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"balance:" + workspaceId}))`);
}

export type TopupSource = "checkout" | "credit";

// Idempotent on `reference` (a Checkout session id, or a note for a manual
// credit): a webhook delivered twice, or the success page racing the
// webhook, credits once.
export async function creditTopup(workspaceId: string, currency: string, amount: number, source: TopupSource, reference: string, by = ""): Promise<{ credited: boolean }> {
  // Checkout credits are always positive; an operator "credit" may be
  // negative to record a refund of unspent balance made in the dashboard.
  if (!Number.isInteger(amount) || amount === 0 || (amount < 0 && source !== "credit")) throw new Error("Top-up amount must be a non-zero integer of minor units (negative only for operator credits).");
  return db.transaction(async (tx) => {
    const inserted = await tx.insert(schema.topups).values({ id: randomUUID(), workspaceId, currency: currency.toUpperCase(), amount, source, reference, by, createdAt: new Date() })
      .onConflictDoNothing({ target: schema.topups.reference }).returning({ id: schema.topups.id });
    if (!inserted.length) return { credited: false };
    await appendEvent(tx, workspaceId, "balance.topup", { topupId: inserted[0].id, currency: currency.toUpperCase(), amount, source, reference, by });
    return { credited: true };
  });
}

export type BalanceSummary = { currency: string; available: number; toppedUp: number; spent: number; topups: typeof schema.topups.$inferSelect[]; cardActivity: typeof schema.transactions.$inferSelect[] };

export async function balanceSummary(workspaceId: string, currency = issuingCurrency()): Promise<BalanceSummary> {
  const topups = await db.select().from(schema.topups).where(and(eq(schema.topups.workspaceId, workspaceId), eq(schema.topups.currency, currency))).orderBy(desc(schema.topups.createdAt)).limit(50);
  const cardActivity = await db.select().from(schema.transactions)
    .where(and(eq(schema.transactions.workspaceId, workspaceId), eq(schema.transactions.currency, currency), eq(schema.transactions.source, "stripe")))
    .orderBy(desc(schema.transactions.createdAt)).limit(50);
  const [t] = await db.select({ s: sql<number>`coalesce(sum(${schema.topups.amount}), 0)::int` }).from(schema.topups).where(and(eq(schema.topups.workspaceId, workspaceId), eq(schema.topups.currency, currency)));
  const toppedUp = Number(t?.s ?? 0);
  const available = await availableBalance(workspaceId, currency);
  return { currency, available, toppedUp, spent: toppedUp - available, topups, cardActivity };
}
