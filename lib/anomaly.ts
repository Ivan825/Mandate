import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db, schema, type Tx } from "./db";

// Anomaly flags: cheap comparisons against the mandate's own history, made
// at decision time and stored with the decision. They never change the
// decision — the terms do that — they change what the person notices.
//
//   unusual_amount  this ask is more than three times the mandate's typical
//                   approved amount (median of the last twenty), with at
//                   least five approvals to compare against
//   new_merchant    first time this merchant appears on this mandate, once
//                   the mandate has some history
//   decline_burst   three or more declines on this mandate in the last ten
//                   minutes — an agent thrashing against its limits
//   rapid_repeat    the same amount at the same merchant was approved less
//                   than two minutes ago — a possible loop or double buy

export type Flag = "unusual_amount" | "new_merchant" | "decline_burst" | "rapid_repeat";

export const FLAG_LABELS: Record<Flag, { label: string; hint: string }> = {
  unusual_amount: { label: "unusual amount", hint: "More than 3× what this agent usually spends per purchase." },
  new_merchant: { label: "new merchant", hint: "First purchase at this merchant under this mandate." },
  decline_burst: { label: "decline burst", hint: "Three or more declines in the last ten minutes — the agent is thrashing." },
  rapid_repeat: { label: "rapid repeat", hint: "The same amount at the same merchant was approved under two minutes ago." },
};

export function parseFlags(json: string | null | undefined): Flag[] {
  try { const v = JSON.parse(json ?? "[]"); return Array.isArray(v) ? v.filter((x): x is Flag => x in FLAG_LABELS) : []; } catch { return []; }
}

export async function computeFlags(conn: Tx | typeof db, mandateId: string, req: { amount: number; merchant: string }, now = new Date()): Promise<Flag[]> {
  const flags: Flag[] = [];
  const t = schema.transactions;
  const recent = await conn.select({ amount: t.amount, merchant: t.merchant, decision: t.decision, createdAt: t.createdAt, authorized: t.authorizedAmount })
    .from(t).where(eq(t.mandateId, mandateId)).orderBy(desc(t.createdAt)).limit(60);
  const approved = recent.filter((r) => r.decision === "approved" && (r.authorized ?? r.amount) > 0);
  const amounts = approved.slice(0, 20).map((r) => r.authorized ?? r.amount).sort((a, b) => a - b);
  if (amounts.length >= 5) {
    const median = amounts[Math.floor(amounts.length / 2)];
    if (req.amount > 3 * median) flags.push("unusual_amount");
  }
  const merchant = req.merchant.trim().toLowerCase();
  if (recent.length >= 3 && !recent.some((r) => r.merchant.trim().toLowerCase() === merchant)) flags.push("new_merchant");
  const tenMinAgo = now.getTime() - 10 * 60_000;
  if (recent.filter((r) => r.decision === "declined" && new Date(r.createdAt).getTime() >= tenMinAgo).length >= 3) flags.push("decline_burst");
  const twoMinAgo = now.getTime() - 2 * 60_000;
  if (approved.some((r) => (r.authorized ?? r.amount) === req.amount && r.merchant.trim().toLowerCase() === merchant && new Date(r.createdAt).getTime() >= twoMinAgo)) flags.push("rapid_repeat");
  void gte; void sql; void and;
  return flags;
}
