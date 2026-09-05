import { pgTable, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { organization, user } from "./auth-schema";

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

// ---------- API-key proxy ----------
// A workspace stores its real provider keys encrypted; an agent receives a
// proxy key bound to one mandate and one provider key. Every call through
// the proxy is pre-authorised from a price table and settled on actual usage.

export const providerKeys = pgTable("provider_keys", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(), // openai | anthropic | gemini
  label: text("label").notNull().default(""),
  ciphertext: text("ciphertext").notNull(),
  hint: text("hint").notNull(), // last 4 characters
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (t) => [index("provider_keys_ws_idx").on(t.workspaceId)]);

export const proxyKeys = pgTable("proxy_keys", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  mandateId: text("mandate_id").notNull().references(() => mandates.id),
  providerKeyId: text("provider_key_id").notNull().references(() => providerKeys.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  status: text("status").notNull().default("active"), // active | revoked
  tokenHash: text("token_hash").notNull(),
  tokenPrefix: text("token_prefix").notNull(),
  tokenReveal: text("token_reveal"),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (t) => [uniqueIndex("proxy_keys_token_hash_idx").on(t.tokenHash), index("proxy_keys_ws_idx").on(t.workspaceId)]);

export const proxyCalls = pgTable("proxy_calls", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  mandateId: text("mandate_id").notNull(),
  proxyKeyId: text("proxy_key_id").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  path: text("path").notNull(),
  transactionId: text("transaction_id"),
  decision: text("decision").notNull(), // approved | declined | pending | error
  estimatedAmount: integer("estimated_amount").notNull(),
  actualAmount: integer("actual_amount"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  upstreamStatus: integer("upstream_status"),
  streamed: integer("streamed").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  settledAt: timestamp("settled_at", { withTimezone: true }),
}, (t) => [index("proxy_calls_ws_idx").on(t.workspaceId, t.createdAt), index("proxy_calls_mandate_idx").on(t.mandateId)]);

// Where each person wants to be reached. A person's channels apply in every
// workspace they belong to; a request goes to every member who may decide it.
export const notificationChannels = pgTable("notification_channels", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  type: text("type").notNull(), // email | webhook
  target: text("target").notNull(), // chat id, email address, or URL
  label: text("label").notNull().default(""),
  enabled: integer("enabled").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (t) => [index("notif_user_idx").on(t.userId)]);

export const rateLimits = pgTable("rate_limits", {
  id: text("id").primaryKey(), // `${key}:${windowStart}`
  windowStart: integer("window_start").notNull(),
  count: integer("count").notNull().default(0),
});

// Verified chain heads, so verification is incremental: only rows after the
// last verified head are re-hashed on each check.
export const ledgerHeads = pgTable("ledger_heads", {
  workspaceId: text("workspace_id").primaryKey(),
  seq: integer("seq").notNull(),
  hash: text("hash").notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
});

// Cardholder details Stripe Issuing requires for a real (non-test) card.
export const cardholderProfiles = pgTable("cardholder_profiles", {
  workspaceId: text("workspace_id").primaryKey().references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  email: text("email").notNull(),
  phone: text("phone").notNull().default(""),
  dob: text("dob").notNull().default(""), // YYYY-MM-DD
  line1: text("line1").notNull(),
  line2: text("line2").notNull().default(""),
  city: text("city").notNull(),
  state: text("state").notNull().default(""),
  postalCode: text("postal_code").notNull(),
  country: text("country").notNull(), // ISO 3166-1 alpha-2
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
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
