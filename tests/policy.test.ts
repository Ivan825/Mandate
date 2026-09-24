import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, merchantMatches, validateTerms, validateVetoTerms, validateAutonomyTerms, endOfLocalDay, localHour, effectiveTerms, replayHistory, type Facts } from "../lib/policy";
import type { Mandate, Approval } from "../lib/schema";

const base: Mandate = {
  id: "m1", agentId: "a1", name: "t", status: "active", currency: "USD",
  perTxnLimit: 5000, dailyLimit: 10000, totalLimit: 50000, approvalAbove: 2000,
  allowedMerchants: JSON.stringify(["OpenAI", "Vercel*"]), blockedCategories: JSON.stringify(["gambling"]),
  activeHoursStart: 0, activeHoursEnd: 24, timezone: "Asia/Kolkata", expiresAt: null, holdTtlHours: 24, holdPolicy: "capture", pausedUntil: null, pausedBy: null, vetoAbove: null, vetoMinutes: 15, mode: "enforce", autonomyStep: 0, autonomyEvery: 10, autonomyCeiling: null, autonomyLevel: 0, autonomyStreak: 0,
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
  const mk = (o: Partial<Approval>): Approval => ({ id: "ap1", workspaceId: "ws1", mandateId: "m1", decidedBy: null, amount: 4500, currency: "USD", merchant: "OpenAI", purpose: "", status: "approved", requestedAt: new Date(), decidedAt: new Date(), expiresAt: new Date(Date.now() + 3600e3), usedAt: null, flags: "[]", kind: "ask", vetoUntil: null, signedWith: null, signature: null, ...o });
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

test("every non-approval carries a remedy the agent can act on", () => {
  const m = { ...base, activeHoursStart: 8, activeHoursEnd: 23 };
  // 03:00 IST → allowed again at 08:00 IST = 02:30Z
  const hours = evaluate(m, { amount: 100, merchant: "OpenAI", now: at("2026-09-05T21:30:00Z") }, facts());
  assert.equal(hours.decision, "declined");
  assert.equal(hours.remedy?.retryAt, "2026-09-06T02:30:00.000Z");
  const daily = evaluate(base, { amount: 4500, merchant: "OpenAI", now: at("2026-09-05T05:30:00Z") }, facts({ spentToday: 6000 }));
  assert.equal(daily.remedy?.retryAt, "2026-09-05T18:30:00.000Z"); // next IST midnight
  assert.equal(daily.remedy?.maxAmountNow, 4000);
  const perTxn = evaluate(base, { amount: 9900, merchant: "OpenAI" }, facts({ spentToday: 8000 }));
  assert.equal(perTxn.remedy?.maxAmountNow, 2000); // today's headroom binds before the per-transaction limit
  const merchant = evaluate(base, { amount: 100, merchant: "Namecheap" }, facts());
  assert.deepEqual(merchant.remedy?.allowedMerchants, ["OpenAI", "Vercel*"]);
  const deniedAt = at("2026-09-05T10:00:00Z");
  const denied = evaluate(base, { amount: 4500, merchant: "OpenAI" }, facts({ recentlyDenied: true, recentlyDeniedAt: deniedAt }));
  assert.equal(denied.remedy?.retryAt, "2026-09-05T16:00:00.000Z");
  const pending = evaluate(base, { amount: 4500, merchant: "OpenAI" }, facts());
  assert.equal(pending.decision, "pending");
  assert.equal(pending.remedy?.approvalRequired, true);
  assert.equal(pending.remedy?.maxAmountNow, 2000); // up to the threshold passes without asking
  const total = evaluate(base, { amount: 4500, merchant: "OpenAI" }, facts({ spentTotal: 50000 }));
  assert.equal(total.remedy?.approvalRequired, true);
  assert.equal(evaluate(base, { amount: 1500, merchant: "OpenAI" }, facts()).remedy, undefined);
});

test("pause declines with a resume time and lifts itself; raises lift one limit for a window", () => {
  const until = at("2026-09-06T12:00:00Z");
  const paused = { ...base, status: "paused", pausedUntil: until };
  const r = evaluate(paused, { amount: 100, merchant: "OpenAI", now: at("2026-09-06T10:00:00Z") }, facts());
  assert.equal(r.rule, "paused"); assert.equal(r.remedy?.retryAt, until.toISOString());
  assert.equal(evaluate(paused, { amount: 100, merchant: "OpenAI", now: at("2026-09-06T12:00:01Z") }, facts()).decision, "approved"); // pause ran out
  const forever = evaluate({ ...base, status: "paused", pausedUntil: null }, { amount: 100, merchant: "OpenAI" }, facts());
  assert.equal(forever.rule, "paused"); assert.equal(forever.remedy?.approvalRequired, true);
  const raise = (field: string, amount: number, endsAt: Date) => ({ id: "o1", workspaceId: "ws1", mandateId: "m1", field, amount, startsAt: at("2026-09-06T00:00:00Z"), endsAt, reason: "", createdBy: "me", createdAt: new Date(), revokedAt: null });
  const now = at("2026-09-06T10:00:00Z");
  // 9900 fails per-txn (5000) unless raised to 10000 — and the raise has to be in force.
  assert.equal(evaluate(base, { amount: 4900, merchant: "OpenAI", now }, facts({ overrides: [raise("per_txn", 10000, at("2026-09-07T00:00:00Z"))] })).decision, "pending");
  assert.equal(evaluate(base, { amount: 9900, merchant: "OpenAI", now }, facts({ overrides: [raise("per_txn", 10000, at("2026-09-07T00:00:00Z"))] })).decision, "pending"); // passes per_txn, escalates
  assert.equal(evaluate(base, { amount: 9900, merchant: "OpenAI", now }, facts({ overrides: [raise("per_txn", 10000, at("2026-09-06T09:00:00Z"))] })).rule, "per_txn"); // expired raise
  assert.equal(evaluate(base, { amount: 9900, merchant: "OpenAI", now }, facts({ overrides: [{ ...raise("per_txn", 10000, at("2026-09-07T00:00:00Z")), revokedAt: now }] })).rule, "per_txn"); // withdrawn
  assert.equal(evaluate(base, { amount: 4900, merchant: "OpenAI", now }, facts({ overrides: [raise("approval_above", 5000, at("2026-09-07T00:00:00Z"))] })).decision, "approved"); // threshold raised: no ask
  assert.equal(effectiveTerms(base, [raise("daily", 1000, at("2026-09-07T00:00:00Z"))], now).dailyLimit, 10000); // a "raise" below the base is ignored
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

test("veto window: pending with retry, matured veto passes, cancel blocks; ask wins above its own threshold", () => {
  const m = { ...base, approvalAbove: 4000, vetoAbove: 1000 };
  const v = evaluate(m, { amount: 1500, merchant: "OpenAI" }, facts());
  assert.equal(v.decision, "pending"); assert.equal(v.rule, "veto"); assert.equal(v.remedy?.approvalRequired, false);
  assert.equal(evaluate(m, { amount: 4500, merchant: "OpenAI" }, facts()).rule, "approval"); // above ask threshold: ask, not veto
  assert.equal(evaluate(m, { amount: 900, merchant: "OpenAI" }, facts()).decision, "approved");
  const matured = { id: "v1", workspaceId: "ws1", mandateId: "m1", decidedBy: "silence", amount: 1500, currency: "USD", merchant: "OpenAI", purpose: "", status: "approved", requestedAt: new Date(), decidedAt: new Date(), expiresAt: new Date(Date.now() + 3600e3), usedAt: null, flags: "[]", kind: "veto", vetoUntil: new Date(), signedWith: null, signature: null };
  const ok = evaluate(m, { amount: 1500, merchant: "OpenAI" }, facts({ approvedAllowances: [matured] }));
  assert.equal(ok.decision, "approved"); assert.equal(ok.rule, "veto_passed"); assert.equal(ok.allowanceId, "v1");
  assert.equal(evaluate(m, { amount: 1500, merchant: "OpenAI" }, facts({ recentlyDenied: true })).rule, "denied_recently");
  assert.ok(validateVetoTerms({ vetoAbove: 5000, vetoMinutes: 15, approvalAbove: 4000, perTxnLimit: 5000 }).length > 0);
  assert.ok(validateVetoTerms({ vetoAbove: 1000, vetoMinutes: 0, approvalAbove: null, perTxnLimit: 5000 }).some((e) => e.field === "vetoMinutes"));
  assert.deepEqual(validateVetoTerms({ vetoAbove: 1000, vetoMinutes: 15, approvalAbove: 4000, perTxnLimit: 5000 }), []);
});

test("an approved plan item passes without asking, once, within the limits", () => {
  const plan = { id: "p1", workspaceId: "ws1", mandateId: "m1", title: "Q4 tools", items: JSON.stringify([{ merchant: "OpenAI", amount: 3000 }, { merchant: "Vercel*", amount: 2500, usedBy: "t9" }]), totalMax: 5500, currency: "USD", status: "approved", proposedBy: "", source: "agent_api", flags: "[]", createdAt: new Date(), decidedAt: new Date(), decidedBy: "me", expiresAt: new Date(Date.now() + 86400e3) };
  const d = evaluate(base, { amount: 2900, merchant: "OpenAI" }, facts({ plans: [plan] }));
  assert.equal(d.decision, "approved"); assert.equal(d.rule, "plan"); assert.equal(d.planId, "p1"); assert.equal(d.planItem, 0);
  assert.equal(evaluate(base, { amount: 3100, merchant: "OpenAI" }, facts({ plans: [plan] })).decision, "pending"); // over the item amount: back to the normal rules
  assert.equal(evaluate(base, { amount: 2100, merchant: "Vercel Pro" }, facts({ plans: [plan] })).rule, "approval"); // used item: normal rules (above the 2000 threshold → ask)
  assert.equal(evaluate(base, { amount: 2900, merchant: "OpenAI" }, facts({ plans: [{ ...plan, expiresAt: new Date(Date.now() - 1) }] })).decision, "pending");
  assert.equal(evaluate(base, { amount: 9000, merchant: "OpenAI" }, facts({ plans: [{ ...plan, items: JSON.stringify([{ merchant: "OpenAI", amount: 9000 }]) }] })).rule, "per_txn"); // limits still apply
});

test("graduated autonomy lifts per-transaction and ask-me-above by the earned level, up to the ceiling", () => {
  const m = { ...base, autonomyStep: 1000, autonomyEvery: 5, autonomyCeiling: 8000, autonomyLevel: 2000 };
  const t = effectiveTerms(m, [], new Date());
  assert.equal(t.perTxnLimit, 7000); assert.equal(t.approvalAbove, 4000); assert.equal(t.autonomy, 2000);
  assert.equal(effectiveTerms({ ...m, autonomyLevel: 9000 }, [], new Date()).perTxnLimit, 8000); // capped at the ceiling
  assert.equal(effectiveTerms({ ...m, autonomyStep: 0 }, [], new Date()).perTxnLimit, 5000); // off
  assert.equal(evaluate(m, { amount: 3500, merchant: "OpenAI" }, facts()).decision, "approved"); // 3500 ≤ lifted threshold 4000
  assert.ok(validateAutonomyTerms({ autonomyStep: 100, autonomyEvery: 5, autonomyCeiling: 4000, perTxnLimit: 5000 }).some((e) => e.field === "autonomyCeiling"));
});

test("policy time-travel replays history against hypothetical terms", () => {
  const at = (h: number) => new Date(Date.UTC(2026, 8, 5, h));
  const history = [
    { id: "a", amount: 1500, merchant: "OpenAI", at: at(3), actual: "approved" },
    { id: "b", amount: 1500, merchant: "OpenAI", at: at(4), actual: "approved" },
    { id: "c", amount: 1500, merchant: "OpenAI", at: at(5), actual: "approved" },
    { id: "d", amount: 4500, merchant: "Anthropic", at: at(6), actual: "declined" },
  ];
  const same = replayHistory({ ...base, allowedMerchants: "[]" }, history);
  assert.deepEqual(same.outcomes.map((o) => o.decision), ["approved", "approved", "approved", "pending"]);
  const tighter = replayHistory({ ...base, allowedMerchants: "[]", dailyLimit: 3000, totalLimit: 3000 }, history);
  assert.deepEqual(tighter.outcomes.map((o) => o.decision), ["approved", "approved", "declined", "declined"]);
  assert.equal(tighter.outcomes[2].rule, "daily"); assert.equal(tighter.changed, 1);
});
