import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { getCtx } from "@/lib/session";
import { db, schema } from "@/lib/db";
import { getMandate } from "@/lib/service";
import { replayHistory, validateTerms } from "@/lib/policy";

// Policy time-travel: POST hypothetical terms, get back what the last N
// decisions would have been under them. Pure replay of the real engine.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const c = await getCtx();
  if (!c) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Not a mandate id." }, { status: 400 });
  const m = await getMandate(c.workspaceId, id);
  if (!m) return NextResponse.json({ error: "No such mandate." }, { status: 404 });
  let body: Partial<{ perTxnLimit: number; dailyLimit: number; totalLimit: number; approvalAbove: number | null; allowedMerchants: string[]; blockedCategories: string[]; activeHoursStart: number; activeHoursEnd: number; vetoAbove: number | null }>;
  try { body = await req.json(); } catch { body = {}; }
  const terms = {
    ...m,
    perTxnLimit: int(body.perTxnLimit, m.perTxnLimit), dailyLimit: int(body.dailyLimit, m.dailyLimit), totalLimit: int(body.totalLimit, m.totalLimit),
    approvalAbove: body.approvalAbove === null ? null : int(body.approvalAbove, m.approvalAbove ?? -1) < 0 ? null : int(body.approvalAbove, m.approvalAbove ?? 0),
    vetoAbove: body.vetoAbove === null ? null : body.vetoAbove === undefined ? m.vetoAbove : int(body.vetoAbove, m.vetoAbove ?? 0),
    allowedMerchants: Array.isArray(body.allowedMerchants) ? JSON.stringify(body.allowedMerchants.map(String).slice(0, 50)) : m.allowedMerchants,
    blockedCategories: Array.isArray(body.blockedCategories) ? JSON.stringify(body.blockedCategories.map(String).slice(0, 50)) : m.blockedCategories,
    activeHoursStart: int(body.activeHoursStart, m.activeHoursStart), activeHoursEnd: int(body.activeHoursEnd, m.activeHoursEnd),
    autonomyLevel: 0,
  };
  const errors = validateTerms({ ...terms, name: m.name });
  if (errors.length) return NextResponse.json({ error: errors.map((e) => e.message).join(" "), errors }, { status: 400 });
  const rows = await db.select({ id: schema.transactions.id, amount: schema.transactions.authorizedAmount, amount0: schema.transactions.amount, merchant: schema.transactions.merchant, category: schema.transactions.category, at: schema.transactions.createdAt, decision: schema.transactions.decision, source: schema.transactions.source, purpose: schema.transactions.purpose })
    .from(schema.transactions).where(and(eq(schema.transactions.mandateId, m.id), sql`${schema.transactions.source} <> 'simulation'`)).orderBy(desc(schema.transactions.createdAt)).limit(500);
  const history = rows.map((r) => ({ id: r.id, amount: r.amount ?? r.amount0, merchant: r.merchant, category: r.category || undefined, at: new Date(r.at), actual: r.decision === "voided" ? "approved" : r.decision }));
  const result = replayHistory(terms, history);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return NextResponse.json({
    ...result, requests: history.length,
    outcomes: result.outcomes.map((o) => { const r = byId.get(o.id)!; return { ...o, amount: r.amount ?? r.amount0, merchant: r.merchant, purpose: r.purpose, at: r.at, source: r.source }; }).reverse(),
    terms: { perTxnLimit: terms.perTxnLimit, dailyLimit: terms.dailyLimit, totalLimit: terms.totalLimit, approvalAbove: terms.approvalAbove, vetoAbove: terms.vetoAbove, allowedMerchants: JSON.parse(terms.allowedMerchants), activeHours: [terms.activeHoursStart, terms.activeHoursEnd] },
  });
}

function int(v: unknown, fallback: number): number { return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback; }
