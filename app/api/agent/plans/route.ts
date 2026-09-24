import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { proposePlan, listPlans, planView } from "@/lib/service";
import { authenticateMandate, readJson } from "@/lib/agent-auth";
import { sendPlanProposed } from "@/lib/notify";
import { logger } from "@/lib/log";

// Pre-approved plans over REST.
//   POST /api/agent/plans   { "title": "Q4 tooling", "items": [{ "merchant": "OpenAI", "amount": 2000, "purpose": "credits" }, …] }
//     → 202 { planId, status: "proposed", … }  The owner approves the list once; purchases inside it then pass without asking.
//   GET  /api/agent/plans   → this mandate's plans
export async function POST(req: NextRequest) {
  const log = logger(req, "agent_api");
  const a = await authenticateMandate(req);
  if (!a.ok) return a.response;
  const body = await readJson<{ title?: unknown; items?: unknown }>(req);
  if (!body || typeof body.title !== "string" || !Array.isArray(body.items)) return NextResponse.json({ error: "title (string) and items (array of { merchant, amount, purpose? }) are required." }, { status: 400 });
  const r = await proposePlan(a.mandate, { title: body.title, items: body.items as { merchant: string; amount: number; purpose?: string }[], proposedBy: `token ${a.mandate.tokenPrefix}…`, source: "agent_api" });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400, headers: { "x-request-id": log.id } });
  after(() => sendPlanProposed(r.plan).catch((e) => console.error("plan notify:", (e as Error).message)));
  log.info("plan.proposed", { planId: r.plan.id, items: JSON.parse(r.plan.items).length, totalMax: r.plan.totalMax });
  return NextResponse.json({ ...planView(r.plan), next: "The owner has been notified. Poll GET /api/agent/plans/:planId until status is approved, then request each purchase normally; items inside the plan pass without asking." }, { status: 202, headers: { "x-request-id": log.id } });
}

export async function GET(req: NextRequest) {
  const a = await authenticateMandate(req);
  if (!a.ok) return a.response;
  const rows = await listPlans(a.mandate.workspaceId, { mandateId: a.mandate.id });
  return NextResponse.json({ plans: rows.map((r) => planView(r.p)) });
}
