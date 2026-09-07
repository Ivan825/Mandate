// The decision engine. Pure: takes a mandate, the request, and the facts
// needed to evaluate it, returns a decision and a human-readable reason.
// Every rule is a sanction condition; the order is the order a credit
// officer would check them in — eligibility first, then scope, then limits,
// then escalation.

import type { Mandate, Approval } from "./schema";

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
  // Prepaid funds the purchase would draw on (card rail only); null when the
  // rail has no balance to check (API, MCP, proxy — the person pays the
  // provider directly).
  availableBalance?: number | null;
};

export type Decision =
  | { decision: "approved"; reason: string; rule: string; allowanceId?: string }
  | { decision: "declined"; reason: string; rule: string }
  | { decision: "pending"; reason: string; rule: string };

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
  const elapsedMs = ((get("hour") % 24) * 3600 + get("minute") * 60 + get("second")) * 1000;
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
    else if (v > 2_147_483_647) errs.push({ field: k, message: "Limits must be below 21,474,836.47 in major units." });
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

export function evaluate(mandate: Mandate, req: AuthRequest, facts: Facts): Decision {
  const now = req.now ?? new Date();
  const amt = req.amount;

  if (!Number.isInteger(amt) || amt <= 0) {
    return { decision: "declined", reason: "Amount must be a positive integer number of minor units.", rule: "amount" };
  }
  if (mandate.status !== "active") {
    return { decision: "declined", reason: `Mandate is ${mandate.status}.`, rule: "status" };
  }
  if (mandate.expiresAt && now > new Date(mandate.expiresAt)) {
    return { decision: "declined", reason: "Mandate expired on " + new Date(mandate.expiresAt).toISOString().slice(0, 10) + ".", rule: "expiry" };
  }

  const hour = localHour(now, mandate.timezone);
  const { activeHoursStart: hs, activeHoursEnd: he } = mandate;
  const inWindow = hs < he ? hour >= hs && hour < he : hour >= hs || hour < he; // supports overnight windows
  if (!(hs === 0 && he === 24) && !inWindow) {
    return { decision: "declined", reason: `Outside active hours (${pad(hs)}:00–${pad(he)}:00 ${mandate.timezone}).`, rule: "hours" };
  }

  const allowed = parseList(mandate.allowedMerchants);
  if (allowed.length > 0 && !allowed.some((p) => merchantMatches(p, req.merchant))) {
    return { decision: "declined", reason: `Merchant "${req.merchant}" is not in the allowed list.`, rule: "merchant" };
  }
  const blocked = parseList(mandate.blockedCategories);
  if (req.category && blocked.some((c) => c.toLowerCase() === req.category!.toLowerCase())) {
    return { decision: "declined", reason: `Category "${req.category}" is blocked.`, rule: "category" };
  }

  if (amt > mandate.perTxnLimit) {
    return { decision: "declined", reason: `Exceeds per-transaction limit of ${fmt(mandate.perTxnLimit, mandate.currency)}.`, rule: "per_txn" };
  }
  if (facts.spentToday + amt > mandate.dailyLimit) {
    return { decision: "declined", reason: `Would exceed today's limit: ${fmt(facts.spentToday, mandate.currency)} used of ${fmt(mandate.dailyLimit, mandate.currency)}.`, rule: "daily" };
  }
  if (facts.spentTotal + amt > mandate.totalLimit) {
    return { decision: "declined", reason: `Would exceed the mandate's total limit: ${fmt(facts.spentTotal, mandate.currency)} used of ${fmt(mandate.totalLimit, mandate.currency)}.`, rule: "total" };
  }
  // A card spends the workspace's prepaid balance; it can never go negative,
  // whatever the mandate's own limits say.
  if (facts.availableBalance != null && amt > facts.availableBalance) {
    return { decision: "declined", reason: `Prepaid balance too low: ${fmt(Math.max(0, facts.availableBalance), mandate.currency)} available. Add funds to the workspace.`, rule: "balance" };
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
      return { decision: "declined", reason: "You denied this same request recently; the agent may ask again after the cooling-off period.", rule: "denied_recently" };
    }
    if (facts.openPending >= MAX_OPEN_PENDING) {
      return { decision: "declined", reason: `Too many requests already waiting on you (${facts.openPending}). Decide those first.`, rule: "too_many_pending" };
    }
    return { decision: "pending", reason: `Above the ${fmt(mandate.approvalAbove, mandate.currency)} threshold — needs your approval before the agent can retry.`, rule: "approval" };
  }

  return { decision: "approved", reason: "Within all mandate limits.", rule: "limits" };
}

function pad(n: number) { return String(n).padStart(2, "0"); }

export function fmt(minor: number, currency: string): string {
  const major = minor / 100;
  try {
    return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(major);
  } catch {
    return `${currency} ${major.toFixed(2)}`;
  }
}
