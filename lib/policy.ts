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
};

export type Decision =
  | { decision: "approved"; reason: string; rule: string; allowanceId?: string }
  | { decision: "declined"; reason: string; rule: string }
  | { decision: "pending"; reason: string; rule: string };

export function parseList(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function localHour(date: Date, timezone: string): number {
  try {
    const s = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: timezone }).format(date);
    return parseInt(s, 10) % 24;
  } catch {
    return date.getUTCHours();
  }
}

// Start of the mandate's local day, as a UTC Date — used to sum "today's" spend.
export function localDayStart(date: Date, timezone: string): Date {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).formatToParts(date);
    const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? "0", 10);
    const elapsedMs = ((get("hour") % 24) * 3600 + get("minute") * 60 + get("second")) * 1000;
    return new Date(date.getTime() - elapsedMs);
  } catch {
    const d = new Date(date);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
}

function merchantMatches(pattern: string, merchant: string): boolean {
  const p = pattern.trim().toLowerCase();
  const m = merchant.trim().toLowerCase();
  if (!p) return false;
  if (p.endsWith("*")) return m.startsWith(p.slice(0, -1));
  return m === p || m.includes(p);
}

export function evaluate(mandate: Mandate, req: AuthRequest, facts: Facts): Decision {
  const now = req.now ?? new Date();
  const amt = Math.round(req.amount);

  if (!Number.isFinite(amt) || amt <= 0) {
    return { decision: "declined", reason: "Amount must be a positive number of minor units.", rule: "amount" };
  }
  if (mandate.status !== "active") {
    return { decision: "declined", reason: `Mandate is ${mandate.status}.`, rule: "status" };
  }
  if (mandate.expiresAt && now > new Date(mandate.expiresAt)) {
    return { decision: "declined", reason: "Mandate expired on " + new Date(mandate.expiresAt).toISOString().slice(0, 10) + ".", rule: "expiry" };
  }

  const hour = localHour(now, mandate.timezone);
  const { activeHoursStart: hs, activeHoursEnd: he } = mandate;
  const inWindow = hs <= he ? hour >= hs && hour < he : hour >= hs || hour < he; // supports overnight windows
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

  // Escalation. A human pre-approval (an "allowance") for at least this
  // amount at this merchant lets the request through once.
  if (mandate.approvalAbove != null && amt > mandate.approvalAbove) {
    const allowance = facts.approvedAllowances.find(
      (a) => a.amount >= amt && merchantMatches(a.merchant, req.merchant)
    );
    if (allowance) {
      return { decision: "approved", reason: `Within limits; covered by human approval ${allowance.id.slice(0, 8)}.`, rule: "allowance", allowanceId: allowance.id };
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
