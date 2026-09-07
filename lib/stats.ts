import { and, desc, eq, gte } from "drizzle-orm";
import { db, schema } from "./db";

// Raw material for the Stats page: one compact row per decision in the last
// year (capped), with the agent and mandate names resolved. Aggregation
// happens in the browser so switching range or grain is instant.

export type StatRow = { t: number; a: number; c: string; d: "approved" | "declined" | "pending" | "voided"; r: string; m: string; s: string; ag: string; md: string; mid: string };

export const STATS_CAP = 5000;

export async function statsRows(workspaceId: string): Promise<{ rows: StatRow[]; truncated: boolean; mandates: { id: string; name: string; agent: string; status: string; totalLimit: number; currency: string }[] }> {
  const since = new Date(Date.now() - 366 * 24 * 3600_000);
  const rows = await db.select({
    t: schema.transactions.createdAt, a: schema.transactions.amount, c: schema.transactions.currency, d: schema.transactions.decision, r: schema.transactions.reason,
    m: schema.transactions.merchant, s: schema.transactions.source, ag: schema.agents.name, md: schema.mandates.name, mid: schema.mandates.id,
  }).from(schema.transactions)
    .innerJoin(schema.mandates, eq(schema.mandates.id, schema.transactions.mandateId))
    .innerJoin(schema.agents, eq(schema.agents.id, schema.mandates.agentId))
    .where(and(eq(schema.transactions.workspaceId, workspaceId), gte(schema.transactions.createdAt, since)))
    .orderBy(desc(schema.transactions.createdAt)).limit(STATS_CAP + 1);
  const mandates = await db.select({ id: schema.mandates.id, name: schema.mandates.name, agent: schema.agents.name, status: schema.mandates.status, totalLimit: schema.mandates.totalLimit, currency: schema.mandates.currency })
    .from(schema.mandates).innerJoin(schema.agents, eq(schema.agents.id, schema.mandates.agentId)).where(eq(schema.mandates.workspaceId, workspaceId));
  return {
    rows: rows.slice(0, STATS_CAP).map((r) => ({ t: new Date(r.t).getTime(), a: r.a, c: r.c, d: r.d as StatRow["d"], r: r.r, m: r.m, s: r.s, ag: r.ag, md: r.md, mid: r.mid })),
    truncated: rows.length > STATS_CAP,
    mandates,
  };
}
