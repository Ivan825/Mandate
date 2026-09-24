// The decision engine. Pure: takes a mandate, the request, and the facts
// needed to evaluate it, returns a decision and a human-readable reason.
// Every rule is a sanction condition; the order is the order a credit
// officer would check them in — eligibility first, then scope, then limits,
// then escalation.

import type { Mandate, Approval, MandateOverride, Plan } from "./schema";
import { fmt } from "./money";

export { fmt };

export type AuthRequest = {
  amount: number; // minor units
  merchant: string;
  category?: string;
  purpose?: string;
  now?: Date;
};

export type Facts = {
  spentToday: number; // approved amount in the mandate's local day
  spentTotal: number; // approved amount over the mandate's life
  approvedAllowances: Approval[]; // status = approved, not yet used
  openPending: number; // pending approvals currently waiting on the owner
  recentlyDenied?: boolean; // owner denied this same (amount, merchant) recently
  recentlyDeniedAt?: Date | null; // when, so the agent can be told when the cooling-off ends
  // Prepaid funds the purchase would draw on (card rail only); null when the
  // rail has no balance to check (API, MCP, proxy — the person pays the
  // provider directly).
  availableBalance?: number | null;
  // Temporary raises in force right now (lib/service loads the live ones).
  overrides?: MandateOverride[];
  // Approved, unexpired plans on this mandate (lib/service loads them).
  plans?: Plan[];
};

export type PlanItem = { merchant: string; amount: number; purpose?: string; usedBy?: string | null };
export function parsePlanItems(json: string): PlanItem[] {
  try { const v = JSON.parse(json); return Array.isArray(v) ? v.filter((x) => x && typeof x.merchant === "string" && Number.isInteger(x.amount)) : []; } catch { return []; }
}

export type OverrideField = "per_txn" | "daily" | "total" | "approval_above";
export const OVERRIDE_FIELDS: { key: OverrideField; label: string }[] = [
  { key: "per_txn", label: "Per transaction" }, { key: "daily", label: "Per day" }, { key: "total", label: "Total sanctioned" }, { key: "approval_above", label: "Ask me above" },
];

export type EffectiveTerms = { perTxnLimit: number; dailyLimit: number; totalLimit: number; approvalAbove: number | null; raised: Partial<Record<OverrideField, MandateOverride>>; autonomy: number };

// The terms in force at `now`: the mandate's own, lifted by earned autonomy
// and by any active temporary raise. Both only ever go up; the issued terms
// are the floor.
export function effectiveTerms(m: Mandate, overrides: MandateOverride[] = [], now = new Date()): EffectiveTerms {
  const autonomy = m.autonomyStep > 0 ? Math.max(0, Math.min(m.autonomyLevel, (m.autonomyCeiling ?? m.perTxnLimit) - m.perTxnLimit)) : 0;
  const t: EffectiveTerms = { perTxnLimit: m.perTxnLimit + autonomy, dailyLimit: m.dailyLimit, totalLimit: m.totalLimit, approvalAbove: m.approvalAbove == null ? null : m.approvalAbove + autonomy, raised: {}, autonomy };
  for (const o of overrides) {
    if (o.revokedAt || new Date(o.startsAt) > now || new Date(o.endsAt) <= now) continue;
    const f = o.field as OverrideField;
    if (f === "per_txn" && o.amount > t.perTxnLimit) { t.perTxnLimit = o.amount; t.raised.per_txn = o; }
    if (f === "daily" && o.amount > t.dailyLimit) { t.dailyLimit = o.amount; t.raised.daily = o; }
    if (f === "total" && o.amount > t.totalLimit) { t.totalLimit = o.amount; t.raised.total = o; }
    if (f === "approval_above" && t.approvalAbove != null && o.amount > t.approvalAbove) { t.approvalAbove = o.amount; t.raised.approval_above = o; }
  }
  return t;
}

// A paused mandate whose pause has run out is active again, whether or not
// anyone has written that back yet.
export function isPaused(m: Mandate, now = new Date()): boolean {
  return m.status === "paused" && !(m.pausedUntil && now >= new Date(m.pausedUntil));
}

// What the agent can do about a decision that was not "approved": when the
// same request would be allowed, the largest amount that would pass right
// now, and one sentence of advice. Agents that understand a "no" stop
// hammering and start planning.
export type Remedy = {
  message: string;
  retryAt?: string; // ISO time after which the same request may pass
  maxAmountNow?: number; // largest amount (minor units) that would pass right now, if any
  approvalRequired?: boolean; // a human must act; retrying sooner changes nothing
  allowedMerchants?: string[];
};

export type Decision =
  | { decision: "approved"; reason: string; rule: string; allowanceId?: string; planId?: string; planItem?: number; remedy?: undefined }
  | { decision: "declined"; reason: string; rule: string; remedy: Remedy }
  | { decision: "pending"; reason: string; rule: string; remedy: Remedy };

export const MAX_OPEN_PENDING = 5;
export const ALLOWANCE_TTL_MS = 24 * 3600 * 1000;
export const DENIAL_COOLOFF_MS = 6 * 3600 * 1000;

export function parseList(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function localHour(date: Date, timezone: string): number {
  const s = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: timezone }).format(date);
  return parseInt(s, 10) % 24;
}

// Start of the mandate's local day, as a UTC Date — used to sum "today's" spend.
export function localDayStart(date: Date, timezone: string): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(date);
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? "0", 10);
  const elapsedMs = ((get("hour") % 24) * 3600 + get("minute") * 60 + get("second")) * 1000 + date.getUTCMilliseconds();
  return new Date(date.getTime() - elapsedMs);
}

// End of a calendar date (YYYY-MM-DD) in the given timezone, as a UTC Date.
export function endOfLocalDay(ymd: string, timezone: string): Date {
  const [y, m, d] = ymd.split("-").map((n) => parseInt(n, 10));
  // Start from UTC noon of that date, find local midnight-start, add 24h.
  const noon = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const start = localDayStart(noon, timezone);
  return new Date(start.getTime() + 24 * 3600 * 1000 - 1);
}

// Exact, case-insensitive match; a trailing * makes it a prefix pattern.
export function merchantMatches(pattern: string, merchant: string): boolean {
  const p = pattern.trim().toLowerCase();
  const m = merchant.trim().toLowerCase();
  if (!p) return false;
  if (p.endsWith("*")) return m.startsWith(p.slice(0, -1));
  return m === p;
}

export type TermsError = { field: string; message: string };

export function validateTerms(t: {
  perTxnLimit: number; dailyLimit: number; totalLimit: number; approvalAbove: number | null;
  activeHoursStart: number; activeHoursEnd: number; timezone: string; currency: string; name: string;
}): TermsError[] {
  const errs: TermsError[] = [];
  if (!t.name.trim()) errs.push({ field: "name", message: "Give the mandate a name." });
  if (!/^[A-Z]{3}$/.test(t.currency)) errs.push({ field: "currency", message: "Currency must be a 3-letter ISO code." });
  for (const [k, v] of [["perTxnLimit", t.perTxnLimit], ["dailyLimit", t.dailyLimit], ["totalLimit", t.totalLimit]] as const) {
    if (!Number.isInteger(v) || v <= 0) errs.push({ field: k, message: "Limits must be positive amounts." });
    else if (v > 2_147_483_647) errs.push({ field: k, message: "Limits must be below 2,147,483,647 minor units." });
  }
  if (t.approvalAbove != null && t.approvalAbove > 2_147_483_647) errs.push({ field: "approvalAbove", message: "Threshold too large." });
  if (t.dailyLimit < t.perTxnLimit) errs.push({ field: "dailyLimit", message: "The daily limit cannot be below the per-transaction limit." });
  if (t.totalLimit < t.dailyLimit) errs.push({ field: "totalLimit", message: "The total limit cannot be below the daily limit." });
  if (t.approvalAbove != null) {
    if (!Number.isInteger(t.approvalAbove) || t.approvalAbove < 0) errs.push({ field: "approvalAbove", message: "The approval threshold must be zero or more." });
    else if (t.approvalAbove >= t.perTxnLimit) errs.push({ field: "approvalAbove", message: "The approval threshold must be below the per-transaction limit, or escalation can never trigger." });
  }
  if (!Number.isInteger(t.activeHoursStart) || t.activeHoursStart < 0 || t.activeHoursStart > 23) errs.push({ field: "activeHoursStart", message: "Start hour must be 0–23." });
  if (!Number.isInteger(t.activeHoursEnd) || t.activeHoursEnd < 1 || t.activeHoursEnd > 24) errs.push({ field: "activeHoursEnd", message: "End hour must be 1–24." });
  if (t.activeHoursStart === t.activeHoursEnd) errs.push({ field: "activeHoursEnd", message: "Start and end hours cannot be equal (that window is empty)." });
  if (!isValidTimezone(t.timezone)) errs.push({ field: "timezone", message: "Unknown timezone." });
  return errs;
}

export function validateVetoTerms(t: { vetoAbove: number | null; vetoMinutes: number; approvalAbove: number | null; perTxnLimit: number }): TermsError[] {
  const errs: TermsError[] = [];
  if (t.vetoAbove != null) {
    if (!Number.isInteger(t.vetoAbove) || t.vetoAbove < 0) errs.push({ field: "vetoAbove", message: "The veto threshold must be zero or more." });
    else if (t.vetoAbove >= t.perTxnLimit) errs.push({ field: "vetoAbove", message: "The veto threshold must be below the per-transaction limit." });
    else if (t.approvalAbove != null && t.vetoAbove >= t.approvalAbove) errs.push({ field: "vetoAbove", message: "The veto threshold must be below the ask-me-above threshold (asking wins above it)." });
  }
  if (!Number.isInteger(t.vetoMinutes) || t.vetoMinutes < 1 || t.vetoMinutes > 24 * 60) errs.push({ field: "vetoMinutes", message: "The veto window is between 1 minute and 24 hours." });
  return errs;
}

export function validateAutonomyTerms(t: { autonomyStep: number; autonomyEvery: number; autonomyCeiling: number | null; perTxnLimit: number }): TermsError[] {
  const errs: TermsError[] = [];
  if (!Number.isInteger(t.autonomyStep) || t.autonomyStep < 0) errs.push({ field: "autonomyStep", message: "The autonomy step must be zero (off) or more." });
  if (t.autonomyStep > 0) {
    if (!Number.isInteger(t.autonomyEvery) || t.autonomyEvery < 1 || t.autonomyEvery > 1000) errs.push({ field: "autonomyEvery", message: "Steps happen every 1–1000 clean decisions." });
    if (t.autonomyCeiling == null || !Number.isInteger(t.autonomyCeiling) || t.autonomyCeiling <= t.perTxnLimit) errs.push({ field: "autonomyCeiling", message: "The autonomy ceiling must be above the per-transaction limit." });
  }
  return errs;
}

// The next moment the mandate's active window opens, as a UTC Date: today's
// local start hour if it is still ahead, otherwise tomorrow's. Half-hour
// zones (India, Adelaide) and DST shifts fall out of localDayStart.
export function nextWindowStart(now: Date, timezone: string, startHour: number): Date {
  const today = localDayStart(now, timezone);
  const candidate = new Date(today.getTime() + startHour * 3600_000);
  if (candidate > now) return candidate;
  const tomorrow = localDayStart(new Date(today.getTime() + 26 * 3600_000), timezone);
  return new Date(tomorrow.getTime() + startHour * 3600_000);
}

export const HOLD_TTL_MAX_HOURS = 24 * 14;

export function validateHoldTerms(t: { holdTtlHours: number; holdPolicy: string }): TermsError[] {
  const errs: TermsError[] = [];
  if (!Number.isInteger(t.holdTtlHours) || t.holdTtlHours < 0 || t.holdTtlHours > HOLD_TTL_MAX_HOURS) errs.push({ field: "holdTtlHours", message: `Holds can stay open between 0 and ${HOLD_TTL_MAX_HOURS} hours.` });
  if (t.holdPolicy !== "capture" && t.holdPolicy !== "release") errs.push({ field: "holdPolicy", message: "An expired hold is either captured or released." });
  return errs;
}

export function evaluate(m0: Mandate, req: AuthRequest, facts: Facts): Decision {
  const now = req.now ?? new Date();
  const amt = req.amount;
  const ccy = m0.currency;
  // Limits are read through any temporary raise in force.
  const eff = effectiveTerms(m0, facts.overrides ?? [], now);
  const mandate = { ...m0, perTxnLimit: eff.perTxnLimit, dailyLimit: eff.dailyLimit, totalLimit: eff.totalLimit, approvalAbove: eff.approvalAbove };
  const headroomToday = Math.max(0, mandate.dailyLimit - facts.spentToday);
  const headroomTotal = Math.max(0, mandate.totalLimit - facts.spentTotal);
  // The largest single request that would pass every limit right now.
  const maxNow = Math.max(0, Math.min(mandate.perTxnLimit, headroomToday, headroomTotal, facts.availableBalance ?? Infinity));
  const declined = (rule: string, reason: string, remedy: Remedy): Decision => ({ decision: "declined", rule, reason, remedy });

  if (!Number.isInteger(amt) || amt <= 0) {
    return declined("amount", "Amount must be a positive integer number of minor units.", { message: "Send amount as a positive integer in minor units (1299 for 12.99)." });
  }
  if (isPaused(mandate, now)) {
    const until = mandate.pausedUntil ? new Date(mandate.pausedUntil).toISOString() : null;
    return declined("paused", `Mandate is paused${until ? ` until ${until}` : ""}.`, { message: until ? `The owner paused this mandate; it resumes at ${until}. Retry then.` : "The owner paused this mandate until further notice. Nothing passes until they resume it.", retryAt: until ?? undefined, approvalRequired: !until });
  }
  if (mandate.status !== "active" && !(mandate.status === "paused" && !isPaused(mandate, now))) {
    return declined("status", `Mandate is ${mandate.status}.`, { message: "This mandate can no longer be used. Ask the owner to issue a new one.", approvalRequired: true });
  }
  if (mandate.expiresAt && now > new Date(mandate.expiresAt)) {
    return declined("expiry", "Mandate expired on " + new Date(mandate.expiresAt).toISOString().slice(0, 10) + ".", { message: "This mandate has expired. Ask the owner to issue a renewal.", approvalRequired: true });
  }

  const hour = localHour(now, mandate.timezone);
  const { activeHoursStart: hs, activeHoursEnd: he } = mandate;
  const inWindow = hs < he ? hour >= hs && hour < he : hour >= hs || hour < he; // supports overnight windows
  if (!(hs === 0 && he === 24) && !inWindow) {
    const at = nextWindowStart(now, mandate.timezone, hs);
    return declined("hours", `Outside active hours (${pad(hs)}:00–${pad(he)}:00 ${mandate.timezone}).`, { message: `Spending under this mandate is allowed between ${pad(hs)}:00 and ${pad(he)}:00 ${mandate.timezone}. Retry at or after ${at.toISOString()}.`, retryAt: at.toISOString(), maxAmountNow: maxNow });
  }

  const allowed = parseList(mandate.allowedMerchants);
  if (allowed.length > 0 && !allowed.some((p) => merchantMatches(p, req.merchant))) {
    return declined("merchant", `Merchant "${req.merchant}" is not in the allowed list.`, { message: `Only these merchants are allowed: ${allowed.join(", ")} (a trailing * matches a prefix). Use one of them, or ask the owner to add "${req.merchant}".`, allowedMerchants: allowed, maxAmountNow: maxNow });
  }
  const blocked = parseList(mandate.blockedCategories);
  if (req.category && blocked.some((c) => c.toLowerCase() === req.category!.toLowerCase())) {
    return declined("category", `Category "${req.category}" is blocked.`, { message: `Purchases in the "${req.category}" category are blocked under this mandate; nothing you retry in this category will pass.` });
  }

  if (amt > mandate.perTxnLimit) {
    return declined("per_txn", `Exceeds per-transaction limit of ${fmt(mandate.perTxnLimit, ccy)}.`, { message: `No single purchase may exceed ${fmt(mandate.perTxnLimit, ccy)}. Right now up to ${fmt(maxNow, ccy)} would pass; a larger purchase needs the owner to raise the limit.`, maxAmountNow: maxNow });
  }
  if (facts.spentToday + amt > mandate.dailyLimit) {
    const at = new Date(localDayStart(now, mandate.timezone).getTime() + 24 * 3600_000);
    return declined("daily", `Would exceed today's limit: ${fmt(facts.spentToday, ccy)} used of ${fmt(mandate.dailyLimit, ccy)}.`, {
      message: headroomToday > 0 ? `${fmt(headroomToday, ccy)} is left today; the daily limit resets at ${at.toISOString()} (${mandate.timezone}).` : `Today's limit is used up; it resets at ${at.toISOString()} (${mandate.timezone}).`,
      retryAt: at.toISOString(), maxAmountNow: maxNow,
    });
  }
  if (facts.spentTotal + amt > mandate.totalLimit) {
    return declined("total", `Would exceed the mandate's total limit: ${fmt(facts.spentTotal, ccy)} used of ${fmt(mandate.totalLimit, ccy)}.`, {
      message: headroomTotal > 0 ? `Only ${fmt(headroomTotal, ccy)} of this mandate's total sanction remains; anything above that needs a new mandate from the owner.` : "This mandate's total sanction is used up; ask the owner to issue a new one.",
      maxAmountNow: maxNow, approvalRequired: headroomTotal === 0,
    });
  }
  // A card spends the workspace's prepaid balance; it can never go negative,
  // whatever the mandate's own limits say.
  if (facts.availableBalance != null && amt > facts.availableBalance) {
    return declined("balance", `Prepaid balance too low: ${fmt(Math.max(0, facts.availableBalance), ccy)} available. Add funds to the workspace.`, { message: "The workspace's prepaid balance cannot cover this. The owner needs to add funds.", maxAmountNow: maxNow, approvalRequired: true });
  }

  // A purchase inside an approved plan was pre-approved as part of the list:
  // same merchant, at most the listed amount, item not yet used. It passes
  // without asking (and without a veto wait); the limits above still apply.
  for (const plan of facts.plans ?? []) {
    if (plan.status !== "approved" || (plan.expiresAt && now > new Date(plan.expiresAt))) continue;
    const items = parsePlanItems(plan.items);
    const idx = items.findIndex((it) => !it.usedBy && merchantMatches(it.merchant, req.merchant) && amt <= it.amount);
    if (idx >= 0) return { decision: "approved", reason: `Within limits; item ${idx + 1} of the approved plan “${plan.title}”.`, rule: "plan", planId: plan.id, planItem: idx };
  }

  // Escalation. A human pre-approval (an "allowance") is for one specific
  // purchase: same amount, same merchant, not lapsed. It lets the request
  // through exactly once.
  if (mandate.approvalAbove != null && amt > mandate.approvalAbove) {
    const allowance = facts.approvedAllowances.find(
      (a) => a.amount === amt && a.merchant.trim().toLowerCase() === req.merchant.trim().toLowerCase()
        && (!a.expiresAt || now <= new Date(a.expiresAt))
    );
    if (allowance) {
      return { decision: "approved", reason: `Within limits; covered by your approval ${allowance.id.slice(0, 8)}.`, rule: "allowance", allowanceId: allowance.id };
    }
    if (facts.recentlyDenied) {
      const at = facts.recentlyDeniedAt ? new Date(new Date(facts.recentlyDeniedAt).getTime() + DENIAL_COOLOFF_MS) : null;
      return declined("denied_recently", "You denied this same request recently; the agent may ask again after the cooling-off period.", { message: `The owner denied this exact request${at ? `; it may be asked again after ${at.toISOString()}` : " recently"}. Change the amount or merchant, or wait.`, retryAt: at?.toISOString(), maxAmountNow: Math.min(maxNow, mandate.approvalAbove) });
    }
    if (facts.openPending >= MAX_OPEN_PENDING) {
      return declined("too_many_pending", `Too many requests already waiting on you (${facts.openPending}). Decide those first.`, { message: `${facts.openPending} requests are already waiting for the owner. Wait for those to be decided; anything up to ${fmt(Math.min(maxNow, mandate.approvalAbove), ccy)} still passes without asking.`, approvalRequired: true, maxAmountNow: Math.min(maxNow, mandate.approvalAbove) });
    }
    return { decision: "pending", reason: `Above the ${fmt(mandate.approvalAbove, ccy)} threshold — needs your approval before the agent can retry.`, rule: "approval", remedy: { message: `Amounts above ${fmt(mandate.approvalAbove, ccy)} need the owner's approval. They have been notified; retry the identical request (same idempotency key) once approved. Approvals lapse after ${ALLOWANCE_TTL_MS / 3600_000} hours. Up to ${fmt(Math.min(maxNow, mandate.approvalAbove), ccy)} passes without asking.`, approvalRequired: true, maxAmountNow: Math.min(maxNow, mandate.approvalAbove) } };
  }

  // Veto window: announced, then goes through after the window unless the
  // owner cancels. A matured window is an allowance like any other.
  if (mandate.vetoAbove != null && amt > mandate.vetoAbove) {
    const allowance = facts.approvedAllowances.find(
      (a) => a.amount === amt && a.merchant.trim().toLowerCase() === req.merchant.trim().toLowerCase() && (!a.expiresAt || now <= new Date(a.expiresAt))
    );
    if (allowance) return { decision: "approved", reason: allowance.decidedBy === "silence" ? "Within limits; the veto window passed without objection." : `Within limits; covered by your approval ${allowance.id.slice(0, 8)}.`, rule: allowance.decidedBy === "silence" ? "veto_passed" : "allowance", allowanceId: allowance.id };
    if (facts.recentlyDenied) {
      const at = facts.recentlyDeniedAt ? new Date(new Date(facts.recentlyDeniedAt).getTime() + DENIAL_COOLOFF_MS) : null;
      return declined("denied_recently", "You cancelled this same request recently; the agent may ask again after the cooling-off period.", { message: `The owner cancelled this exact request${at ? `; it may be asked again after ${at.toISOString()}` : " recently"}.`, retryAt: at?.toISOString(), maxAmountNow: Math.min(maxNow, mandate.vetoAbove) });
    }
    return { decision: "pending", reason: `Above the ${fmt(mandate.vetoAbove, ccy)} veto threshold — goes through in ${mandate.vetoMinutes} minutes unless the owner cancels.`, rule: "veto", remedy: { message: `Amounts above ${fmt(mandate.vetoAbove, ccy)} are announced to the owner and go through after ${mandate.vetoMinutes} minutes unless cancelled. Retry the identical request (same idempotency key) after retryAt.`, approvalRequired: false, maxAmountNow: Math.min(maxNow, mandate.vetoAbove) } };
  }

  return { decision: "approved", reason: "Within all mandate limits.", rule: "limits" };
}

// ---------- Policy time-travel ----------
//
// Replay a mandate's history against different terms. Pure: the same engine,
// fed facts rebuilt from the replay's own approvals, so "what if the daily
// limit were 30" is answered by the code that would enforce it. Requests the
// engine would have escalated stay "pending" (nobody can approve the past).

export type ReplayRequest = { id: string; amount: number; merchant: string; category?: string; at: Date; actual: string };
export type ReplayOutcome = { id: string; decision: string; rule: string; actual: string; changed: boolean };

export function replayHistory(terms: Mandate, requests: ReplayRequest[]): { outcomes: ReplayOutcome[]; counts: Record<string, number>; changed: number } {
  const sorted = [...requests].sort((a, b) => a.at.getTime() - b.at.getTime());
  const approvedRows: { amount: number; at: Date }[] = [];
  const outcomes: ReplayOutcome[] = [];
  const counts: Record<string, number> = { approved: 0, declined: 0, pending: 0 };
  for (const r of sorted) {
    const dayStart = localDayStart(r.at, terms.timezone);
    const spentToday = approvedRows.filter((x) => x.at >= dayStart && x.at <= r.at).reduce((s, x) => s + x.amount, 0);
    const spentTotal = approvedRows.reduce((s, x) => s + x.amount, 0);
    const d = evaluate({ ...terms, status: "active", expiresAt: null, pausedUntil: null }, { amount: r.amount, merchant: r.merchant, category: r.category, now: r.at }, { spentToday, spentTotal, approvedAllowances: [], openPending: 0, recentlyDenied: false, availableBalance: null });
    if (d.decision === "approved") approvedRows.push({ amount: r.amount, at: r.at });
    counts[d.decision] = (counts[d.decision] ?? 0) + 1;
    outcomes.push({ id: r.id, decision: d.decision, rule: d.rule, actual: r.actual, changed: d.decision !== r.actual });
  }
  return { outcomes, counts, changed: outcomes.filter((o) => o.changed).length };
}

function pad(n: number) { return String(n).padStart(2, "0"); }
