import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, merchantMatches, validateTerms, endOfLocalDay, localHour, type Facts } from "../lib/policy";
import type { Mandate, Approval } from "../lib/schema";

const base: Mandate = {
  id: "m1", agentId: "a1", name: "t", status: "active", currency: "USD",
  perTxnLimit: 5000, dailyLimit: 10000, totalLimit: 50000, approvalAbove: 2000,
  allowedMerchants: JSON.stringify(["OpenAI", "Vercel*"]), blockedCategories: JSON.stringify(["gambling"]),
  activeHoursStart: 0, activeHoursEnd: 24, timezone: "Asia/Kolkata", expiresAt: null,
  workspaceId: "ws1", tokenHash: "h", tokenPrefix: "mnd_x", tokenReveal: null, stripeCardholderId: null, stripeCardId: null, cardLast4: null, cardExp: null, cardStatus: null, cardError: null,
  createdAt: new Date(), revokedAt: null,
};
const facts = (o: Partial<Facts> = {}): Facts => ({ spentToday: 0, spentTotal: 0, approvedAllowances: [], openPending: 0, recentlyDenied: false, ...o });
const at = (iso: string) => new Date(iso);

test("merchant matching is exact or explicit prefix, never substring", () => {
  assert.equal(merchantMatches("Anthropic", "NotAnthropic Scam LLC"), false);
  assert.equal(merchantMatches("Anthropic", "anthropic"), true);
  assert.equal(merchantMatches("Vercel*", "Vercel Pro"), true);
  assert.equal(merchantMatches("Vercel*", "NotVercel"), false);
});

test("rule order: scope before limits, limits before escalation", () => {
  assert.equal(evaluate(base, { amount: 100, merchant: "Namecheap" }, facts()).rule, "merchant");
  assert.equal(evaluate(base, { amount: 100, merchant: "OpenAI", category: "gambling" }, facts()).rule, "category");
  assert.equal(evaluate(base, { amount: 9900, merchant: "OpenAI" }, facts()).rule, "per_txn");
  assert.equal(evaluate(base, { amount: 4500, merchant: "OpenAI" }, facts({ spentToday: 6000 })).rule, "daily");
  assert.equal(evaluate(base, { amount: 4500, merchant: "OpenAI" }, facts({ spentTotal: 46000 })).rule, "total");
  assert.equal(evaluate(base, { amount: 4500, merchant: "OpenAI" }, facts()).decision, "pending");
  assert.equal(evaluate(base, { amount: 1500, merchant: "OpenAI" }, facts()).decision, "approved");
});

test("allowance must match exact amount and merchant and be unexpired", () => {
  const mk = (o: Partial<Approval>): Approval => ({ id: "ap1", workspaceId: "ws1", mandateId: "m1", decidedBy: null, amount: 4500, currency: "USD", merchant: "OpenAI", purpose: "", status: "approved", requestedAt: new Date(), decidedAt: new Date(), expiresAt: new Date(Date.now() + 3600e3), usedAt: null, ...o });
  assert.equal(evaluate(base, { amount: 4500, merchant: "OpenAI" }, facts({ approvedAllowances: [mk({})] })).rule, "allowance");
  assert.equal(evaluate(base, { amount: 4400, merchant: "OpenAI" }, facts({ approvedAllowances: [mk({})] })).decision, "pending");
  assert.equal(evaluate(base, { amount: 4500, merchant: "openai" }, facts({ approvedAllowances: [mk({})] })).rule, "allowance");
  assert.equal(evaluate(base, { amount: 4500, merchant: "OpenAI" }, facts({ approvedAllowances: [mk({ expiresAt: new Date(Date.now() - 1) })] })).decision, "pending");
});

test("escalation guards: cooling-off after denial, cap on open pending", () => {
  assert.equal(evaluate(base, { amount: 4500, merchant: "OpenAI" }, facts({ recentlyDenied: true })).rule, "denied_recently");
  assert.equal(evaluate(base, { amount: 4500, merchant: "OpenAI" }, facts({ openPending: 5 })).rule, "too_many_pending");
});

test("hours windows, including overnight, in the mandate's timezone", () => {
  const m = { ...base, activeHoursStart: 8, activeHoursEnd: 23 };
  // 03:00 IST = 21:30Z previous day
  assert.equal(evaluate(m, { amount: 100, merchant: "OpenAI", now: at("2026-09-05T21:30:00Z") }, facts()).rule, "hours");
  assert.equal(evaluate(m, { amount: 100, merchant: "OpenAI", now: at("2026-09-05T05:30:00Z") }, facts()).decision, "approved"); // 11:00 IST
  const night = { ...base, activeHoursStart: 22, activeHoursEnd: 6 };
  assert.equal(evaluate(night, { amount: 100, merchant: "OpenAI", now: at("2026-09-05T21:30:00Z") }, facts()).decision, "approved"); // 03:00 IST
  assert.equal(evaluate(night, { amount: 100, merchant: "OpenAI", now: at("2026-09-05T05:30:00Z") }, facts()).rule, "hours");
  assert.equal(localHour(at("2026-09-05T18:30:00Z"), "Asia/Kolkata"), 0);
});

test("expiry is end of the chosen day in the mandate's timezone", () => {
  const exp = endOfLocalDay("2026-09-30", "Asia/Kolkata");
  assert.equal(exp.toISOString(), "2026-09-30T18:29:59.999Z");
  const m = { ...base, expiresAt: exp };
  assert.equal(evaluate(m, { amount: 100, merchant: "OpenAI", now: at("2026-09-30T18:00:00Z") }, facts()).decision, "approved");
  assert.equal(evaluate(m, { amount: 100, merchant: "OpenAI", now: at("2026-09-30T18:30:00Z") }, facts()).rule, "expiry");
});

test("amount must be a positive integer; revoked mandates decline", () => {
  assert.equal(evaluate(base, { amount: 12.5, merchant: "OpenAI" }, facts()).rule, "amount");
  assert.equal(evaluate(base, { amount: 0, merchant: "OpenAI" }, facts()).rule, "amount");
  assert.equal(evaluate({ ...base, status: "revoked" }, { amount: 100, merchant: "OpenAI" }, facts()).rule, "status");
});

test("term validation catches contradictory sanction terms", () => {
  const ok = { name: "x", currency: "USD", perTxnLimit: 5000, dailyLimit: 10000, totalLimit: 50000, approvalAbove: 2000, activeHoursStart: 0, activeHoursEnd: 24, timezone: "Asia/Kolkata" };
  assert.deepEqual(validateTerms(ok), []);
  assert.ok(validateTerms({ ...ok, approvalAbove: 5000 }).some((e) => e.field === "approvalAbove"));
  assert.ok(validateTerms({ ...ok, dailyLimit: 4000 }).some((e) => e.field === "dailyLimit"));
  assert.ok(validateTerms({ ...ok, activeHoursStart: 9, activeHoursEnd: 9 }).some((e) => e.field === "activeHoursEnd"));
  assert.ok(validateTerms({ ...ok, timezone: "Asia/Kolkatta" }).some((e) => e.field === "timezone"));
  assert.ok(validateTerms({ ...ok, perTxnLimit: 0 }).length > 0);
});

test("prepaid balance caps card spend after the mandate's own limits", () => {
  // Limits pass, balance fails.
  const r = evaluate(base, { amount: 1500, merchant: "OpenAI", now: new Date("2026-09-06T10:00:00Z") }, facts({ availableBalance: 1000 }));
  assert.equal(r.decision, "declined"); assert.equal(r.rule, "balance");
  // Exactly the balance is fine.
  assert.equal(evaluate(base, { amount: 1000, merchant: "OpenAI", now: new Date("2026-09-06T10:00:00Z") }, facts({ availableBalance: 1000 })).decision, "approved");
  // Rails without a balance (null) never see the rule.
  assert.equal(evaluate(base, { amount: 1500, merchant: "OpenAI", now: new Date("2026-09-06T10:00:00Z") }, facts({ availableBalance: null })).decision, "approved");
  // Limits are checked first so the reason names the mandate, not the balance.
  assert.equal(evaluate(base, { amount: 999999, merchant: "OpenAI", now: new Date("2026-09-06T10:00:00Z") }, facts({ availableBalance: 0 })).rule, "per_txn");
});
