import { pgTable, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";

export * from "./auth-schema";

// Every row belongs to a workspace (a Better Auth organisation). A person gets
// a personal workspace on first sign-in; households and teams are workspaces
// with more members. Amounts are integers in minor units (paise, cents).

export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (t) => [index("agents_ws_idx").on(t.workspaceId)]);

export const mandates = pgTable("mandates", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
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
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  // The agent's credential is never stored in clear. tokenHash is what we
  // look up by; tokenPrefix is shown so the owner can recognise it;
  // tokenReveal holds the plaintext until it has been shown exactly once.
  tokenHash: text("token_hash").notNull(),
  tokenPrefix: text("token_prefix").notNull(),
  tokenReveal: text("token_reveal"),
  stripeCardholderId: text("stripe_cardholder_id"),
  stripeCardId: text("stripe_card_id"),
  cardLast4: text("card_last4"),
  cardError: text("card_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("mandates_token_hash_idx").on(t.tokenHash),
  index("mandates_card_idx").on(t.stripeCardId),
  index("mandates_ws_idx").on(t.workspaceId),
]);

export const transactions = pgTable("transactions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  mandateId: text("mandate_id").notNull().references(() => mandates.id),
  amount: integer("amount").notNull(),
  currency: text("currency").notNull(),
  merchant: text("merchant").notNull(),
  category: text("category").notNull().default(""),
  purpose: text("purpose").notNull().default(""),
  decision: text("decision").notNull(), // approved | declined | pending
  reason: text("reason").notNull(),
  source: text("source").notNull(), // simulation | agent_api | mcp | stripe
  actor: text("actor").notNull().default(""), // e.g. OAuth client name for MCP calls
  stripeAuthorizationId: text("stripe_authorization_id"),
  approvalId: text("approval_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (t) => [index("txn_mandate_decision_idx").on(t.mandateId, t.decision, t.createdAt), index("txn_ws_idx").on(t.workspaceId, t.createdAt)]);

export const approvals = pgTable("approvals", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  mandateId: text("mandate_id").notNull().references(() => mandates.id),
  amount: integer("amount").notNull(),
  currency: text("currency").notNull(),
  merchant: text("merchant").notNull(),
  purpose: text("purpose").notNull().default(""),
  status: text("status").notNull().default("pending"), // pending | approved | denied | used | expired
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decidedBy: text("decided_by"),
  expiresAt: timestamp("expires_at", { withTimezone: true }), // an approved allowance lapses after this
  usedAt: timestamp("used_at", { withTimezone: true }),
}, (t) => [index("approvals_mandate_status_idx").on(t.mandateId, t.status), index("approvals_ws_status_idx").on(t.workspaceId, t.status)]);

// Append-only, hash-chained log, one chain per workspace. Each hash covers
// the previous hash, so any edit or deletion breaks verification onward.
export const ledger = pgTable("ledger", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  seq: integer("seq").notNull(),
  type: text("type").notNull(),
  payload: text("payload").notNull(), // canonical JSON
  prevHash: text("prev_hash").notNull(),
  hash: text("hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (t) => [uniqueIndex("ledger_ws_seq_idx").on(t.workspaceId, t.seq)]);

// An agent's retry after a network error must not become a second purchase:
// the same Idempotency-Key on the same mandate returns the stored answer.
export const idempotencyKeys = pgTable("idempotency_keys", {
  id: text("id").primaryKey(), // `${mandateId}:${key}`
  mandateId: text("mandate_id").notNull(),
  status: integer("status").notNull(),
  response: text("response").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

// Stripe delivers webhooks at least once; remember what we've handled.
export const stripeEvents = pgTable("stripe_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
});


export type Agent = typeof agents.$inferSelect;
export type Mandate = typeof mandates.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
export type LedgerEvent = typeof ledger.$inferSelect;
