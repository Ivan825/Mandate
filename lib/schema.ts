import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

// Amounts are stored in minor units (paise, cents). Currency is an ISO code.

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const mandates = sqliteTable("mandates", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.id),
  name: text("name").notNull(),
  status: text("status").notNull().default("active"), // active | revoked | expired
  currency: text("currency").notNull().default("USD"),
  perTxnLimit: integer("per_txn_limit").notNull(),
  dailyLimit: integer("daily_limit").notNull(),
  totalLimit: integer("total_limit").notNull(),
  approvalAbove: integer("approval_above"), // null = never ask a human
  allowedMerchants: text("allowed_merchants").notNull().default("[]"), // JSON string[]
  blockedCategories: text("blocked_categories").notNull().default("[]"), // JSON string[]
  activeHoursStart: integer("active_hours_start").notNull().default(0),
  activeHoursEnd: integer("active_hours_end").notNull().default(24),
  timezone: text("timezone").notNull().default("Asia/Kolkata"),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  // The agent's credential is never stored in clear. tokenHash is what we
  // look up by; tokenPrefix is shown so the owner can recognise it;
  // tokenReveal holds the plaintext until it has been shown exactly once.
  tokenHash: text("token_hash").notNull().unique(),
  tokenPrefix: text("token_prefix").notNull(),
  tokenReveal: text("token_reveal"),
  stripeCardholderId: text("stripe_cardholder_id"),
  stripeCardId: text("stripe_card_id"),
  cardLast4: text("card_last4"),
  cardError: text("card_error"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
}, (t) => [index("mandates_card_idx").on(t.stripeCardId)]);

export const transactions = sqliteTable("transactions", {
  id: text("id").primaryKey(),
  mandateId: text("mandate_id").notNull().references(() => mandates.id),
  amount: integer("amount").notNull(),
  currency: text("currency").notNull(),
  merchant: text("merchant").notNull(),
  category: text("category").notNull().default(""),
  purpose: text("purpose").notNull().default(""),
  decision: text("decision").notNull(), // approved | declined | pending
  reason: text("reason").notNull(),
  source: text("source").notNull(), // simulation | agent_api | stripe
  stripeAuthorizationId: text("stripe_authorization_id"),
  approvalId: text("approval_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (t) => [index("txn_mandate_decision_idx").on(t.mandateId, t.decision, t.createdAt)]);

export const approvals = sqliteTable("approvals", {
  id: text("id").primaryKey(),
  mandateId: text("mandate_id").notNull().references(() => mandates.id),
  amount: integer("amount").notNull(),
  currency: text("currency").notNull(),
  merchant: text("merchant").notNull(),
  purpose: text("purpose").notNull().default(""),
  status: text("status").notNull().default("pending"), // pending | approved | denied | used | expired
  requestedAt: integer("requested_at", { mode: "timestamp_ms" }).notNull(),
  decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }), // an approved allowance lapses after this
  usedAt: integer("used_at", { mode: "timestamp_ms" }),
}, (t) => [index("approvals_mandate_status_idx").on(t.mandateId, t.status)]);

// Append-only, hash-chained log. Each hash covers the previous hash, so any
// edit or deletion breaks verification from that row onward.
export const ledger = sqliteTable("ledger", {
  id: text("id").primaryKey(),
  seq: integer("seq").notNull().unique(),
  type: text("type").notNull(),
  payload: text("payload").notNull(), // canonical JSON
  prevHash: text("prev_hash").notNull(),
  hash: text("hash").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

// An agent's retry after a network error must not become a second purchase:
// the same Idempotency-Key on the same mandate returns the stored answer.
export const idempotencyKeys = sqliteTable("idempotency_keys", {
  id: text("id").primaryKey(), // `${mandateId}:${key}`
  mandateId: text("mandate_id").notNull(),
  status: integer("status").notNull(),
  response: text("response").notNull(), // JSON body as first returned
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

// Stripe delivers webhooks at least once; remember what we've handled.
export const stripeEvents = sqliteTable("stripe_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  receivedAt: integer("received_at", { mode: "timestamp_ms" }).notNull(),
});

export type Agent = typeof agents.$inferSelect;
export type Mandate = typeof mandates.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
export type LedgerEvent = typeof ledger.$inferSelect;
