import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db, schema } from "./db";
import { recordEvent } from "./ledger";
import { sendWarning } from "./notify";
import { fmt, localDayStart } from "./policy";
import type { Mandate } from "./schema";

// Early warnings, the way a credit desk watches utilisation and velocity.
// Fired after an approved decision, at most once per mandate per kind per
// window, through the workspace's approver channels. Never blocks a decision.

const UTIL_THRESHOLD = 0.8;
const VELOCITY_COUNT = 10;     // approvals …
const VELOCITY_WINDOW_MS = 10 * 60_000; // … within ten minutes

async function firedRecently(workspaceId: string, mandateId: string, kind: string, withinMs: number): Promise<boolean> {
  const since = new Date(Date.now() - withinMs);
  const [row] = await db.select({ id: schema.ledger.id }).from(schema.ledger)
    .where(and(eq(schema.ledger.workspaceId, workspaceId), eq(schema.ledger.type, "warning.fired"), gte(schema.ledger.createdAt, since), sql`${schema.ledger.payload} like ${'%"kind":"' + kind + '"%'} and ${schema.ledger.payload} like ${'%"mandateId":"' + mandateId + '"%'}`))
    .orderBy(desc(schema.ledger.seq)).limit(1);
  return Boolean(row);
}

export async function checkWarnings(m: Mandate, agentName: string, facts: { spentToday: number; spentTotal: number }) {
  const ws = m.workspaceId;
  const fire = async (kind: string, title: string, body: string, extra: Record<string, unknown>, windowMs: number) => {
    if (await firedRecently(ws, m.id, kind, windowMs)) return;
    const outcomes = await sendWarning(ws, title, body, { kind, mandateId: m.id, mandateName: m.name, agentName, ...extra });
    await recordEvent(ws, "warning.fired", { kind, mandateId: m.id, agentName, ...extra, channels: outcomes.length });
  };
  try {
    if (m.dailyLimit > 0 && facts.spentToday / m.dailyLimit >= UTIL_THRESHOLD) {
      await fire("daily_80", `${agentName} has used ${Math.round((facts.spentToday / m.dailyLimit) * 100)}% of today's limit`, `${m.name}: ${fmt(facts.spentToday, m.currency)} of ${fmt(m.dailyLimit, m.currency)} today.`, { spentToday: facts.spentToday, dailyLimit: m.dailyLimit }, 24 * 3600_000);
    }
    if (m.totalLimit > 0 && facts.spentTotal / m.totalLimit >= UTIL_THRESHOLD) {
      await fire("total_80", `${agentName} has used ${Math.round((facts.spentTotal / m.totalLimit) * 100)}% of its total sanction`, `${m.name}: ${fmt(facts.spentTotal, m.currency)} of ${fmt(m.totalLimit, m.currency)} overall. Consider issuing a renewal or tightening terms.`, { spentTotal: facts.spentTotal, totalLimit: m.totalLimit }, 7 * 24 * 3600_000);
    }
    const since = new Date(Date.now() - VELOCITY_WINDOW_MS);
    const [v] = await db.select({ c: sql<number>`count(*)::int` }).from(schema.transactions).where(and(eq(schema.transactions.mandateId, m.id), eq(schema.transactions.decision, "approved"), gte(schema.transactions.createdAt, since)));
    if (Number(v?.c ?? 0) >= VELOCITY_COUNT) {
      await fire("velocity", `${agentName} made ${v.c} approved purchases in ten minutes`, `${m.name}: unusual velocity. If this isn't expected, revoke the mandate.`, { count: v.c, windowMinutes: 10 }, 3600_000);
    }
    void localDayStart;
  } catch (e) {
    console.error("warnings:", (e as Error).message);
  }
}
