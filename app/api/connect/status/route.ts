import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gt } from "drizzle-orm";
import { getCtx } from "@/lib/session";
import { db, schema } from "@/lib/db";
import { listConnectedAgents } from "@/lib/connections";
import { fmt } from "@/lib/money";

// The connect wizard polls this: has the agent called yet? Scoped to the
// signed-in person's workspace; optionally to one mandate; only calls after
// `since`, so an old decision doesn't masquerade as the new agent's first.
export async function GET(req: NextRequest) {
  const ctx = await getCtx();
  if (!ctx) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const mandateId = req.nextUrl.searchParams.get("mandate");
  const sinceRaw = req.nextUrl.searchParams.get("since");
  const since = sinceRaw && !Number.isNaN(Date.parse(sinceRaw)) ? new Date(sinceRaw) : new Date(Date.now() - 3600_000);
  const t = schema.transactions;
  const [last] = await db.select({ t, agentName: schema.agents.name, mandateName: schema.mandates.name }).from(t)
    .innerJoin(schema.mandates, eq(schema.mandates.id, t.mandateId)).innerJoin(schema.agents, eq(schema.agents.id, schema.mandates.agentId))
    .where(and(eq(t.workspaceId, ctx.workspaceId), gt(t.createdAt, since), mandateId && /^[0-9a-f-]{36}$/i.test(mandateId) ? eq(t.mandateId, mandateId) : undefined))
    .orderBy(desc(t.createdAt)).limit(1);
  const connected = (await listConnectedAgents(ctx.userId)).filter((c) => c.workspaceId === ctx.workspaceId).map((c) => ({ name: c.name, scopes: c.scopes, grantedAt: c.grantedAt }));
  return NextResponse.json({
    lastCall: last ? { at: last.t.createdAt, source: last.t.source, actor: last.t.actor, decision: last.t.decision, rule: last.t.reason, amount: fmt(last.t.amount, last.t.currency), merchant: last.t.merchant, agent: last.agentName, mandate: last.mandateName, settlement: last.t.settlement } : null,
    connected,
  }, { headers: { "cache-control": "no-store" } });
}
