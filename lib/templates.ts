import { minorUnits } from "./money";

// Starting points for a mandate. Amounts are given in US dollars and scaled
// roughly into the chosen currency; the person edits before issuing.

export type Template = {
  key: string; name: string; who: string; blurb: string;
  perTxn: number; daily: number; total: number; approvalAbove: number | null; // USD major units
  allowedMerchants: string[]; blockedCategories: string[];
  activeHoursStart: number; activeHoursEnd: number; expiresDays: number;
  holdTtlHours: number; holdPolicy: "capture" | "release";
};

export const TEMPLATES: Template[] = [
  { key: "llm-dev", name: "LLM dev budget", who: "Claude Code, Cursor, a coding agent", blurb: "API credits and developer tools for one project. Asks above a small amount; nothing at night.",
    perTxn: 25, daily: 50, total: 200, approvalAbove: 10, allowedMerchants: ["OpenAI", "Anthropic", "Google", "Vercel*", "GitHub", "Cloudflare"], blockedCategories: ["gambling", "crypto", "cash_advance"], activeHoursStart: 0, activeHoursEnd: 24, expiresDays: 30, holdTtlHours: 24, holdPolicy: "capture" },
  { key: "shopping", name: "Shopping assistant", who: "An agent that reorders things you already buy", blurb: "Groceries and household supplies at the shops you name. Working hours only; asks above a weekly-shop amount.",
    perTxn: 60, daily: 80, total: 400, approvalAbove: 40, allowedMerchants: [], blockedCategories: ["alcohol", "gambling", "adult"], activeHoursStart: 7, activeHoursEnd: 22, expiresDays: 30, holdTtlHours: 72, holdPolicy: "release" },
  { key: "research", name: "Research agent", who: "Deep-research or browsing agents", blurb: "Paywalled articles, datasets, a report or two. Small per-purchase cap, generous count.",
    perTxn: 15, daily: 40, total: 150, approvalAbove: 8, allowedMerchants: [], blockedCategories: ["gambling", "crypto"], activeHoursStart: 0, activeHoursEnd: 24, expiresDays: 14, holdTtlHours: 24, holdPolicy: "capture" },
  { key: "ops", name: "Ops automation", who: "n8n / Zapier flows, scripts that pay for infrastructure", blurb: "Domains, hosting, SaaS seats. Never asks below the cap because nobody is watching at 3 am — the cap is the control.",
    perTxn: 100, daily: 150, total: 1000, approvalAbove: null, allowedMerchants: [], blockedCategories: ["gambling", "crypto", "cash_advance"], activeHoursStart: 0, activeHoursEnd: 24, expiresDays: 90, holdTtlHours: 48, holdPolicy: "capture" },
  { key: "sub-agent", name: "Sub-agent slice", who: "A worker spawned by another agent", blurb: "A thin slice for one task: tiny caps, short life, always captured. Issue one per run.",
    perTxn: 5, daily: 10, total: 20, approvalAbove: 3, allowedMerchants: [], blockedCategories: [], activeHoursStart: 0, activeHoursEnd: 24, expiresDays: 2, holdTtlHours: 6, holdPolicy: "capture" },
  { key: "household", name: "Household bills", who: "An agent that keeps subscriptions and utilities paid", blurb: "Recurring bills at named billers. Asks for anything unusual.",
    perTxn: 200, daily: 300, total: 1500, approvalAbove: 100, allowedMerchants: [], blockedCategories: ["gambling", "crypto", "cash_advance"], activeHoursStart: 6, activeHoursEnd: 23, expiresDays: 90, holdTtlHours: 24, holdPolicy: "capture" },
];

const ROUGH: Record<string, number> = { INR: 80, JPY: 150, KRW: 1300, IDR: 16000, VND: 25000, PHP: 55, THB: 35, EGP: 50, PKR: 280, BDT: 120, LKR: 300, NGN: 1500, KES: 130, TRY: 35, MXN: 18, BRL: 5, ZAR: 18, CNY: 7, HKD: 8, SEK: 10, NOK: 10, DKK: 7, PLN: 4, CZK: 23, AED: 3.7, SAR: 3.75, MYR: 4.5, ILS: 3.7, KWD: 0.3, BHD: 0.38 };

export function scaleUsd(usd: number, currency: string): string {
  const n = usd * (ROUGH[currency.toUpperCase()] ?? 1);
  const d = minorUnits(currency);
  if (d === 0) return String(Math.round(n));
  // Round to a tidy figure: whole units above 10, else two decimals.
  return n >= 10 ? String(Math.round(n)) : String(Math.round(n * 100) / 100);
}

export function templateValues(t: Template, currency: string): Record<string, string> {
  return {
    currency, name: t.name,
    perTxnLimit: scaleUsd(t.perTxn, currency), dailyLimit: scaleUsd(t.daily, currency), totalLimit: scaleUsd(t.total, currency),
    approvalAbove: t.approvalAbove == null ? "" : scaleUsd(t.approvalAbove, currency),
    allowedMerchants: t.allowedMerchants.join("\n"), blockedCategories: t.blockedCategories.join("\n"),
    activeHoursStart: String(t.activeHoursStart), activeHoursEnd: String(t.activeHoursEnd),
    expiresAt: new Date(Date.now() + t.expiresDays * 86400_000).toISOString().slice(0, 10),
    holdTtlHours: String(t.holdTtlHours), holdPolicy: t.holdPolicy,
  };
}
