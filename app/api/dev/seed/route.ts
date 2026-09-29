import { NextResponse } from "next/server";
import { getCtx, can, sameOriginRequest } from "@/lib/session";
import { createAgent, createMandate, authorize, listAgents, captureTransaction, delegateMandate, openDispute } from "@/lib/service";
import { addRoute } from "@/lib/routing";
import { anchorWorkspace } from "@/lib/anchors";

// Populates the signed-in user's workspace with a demo state. Development
// only (or ALLOW_SEED=1); runs once per empty workspace. It mutates, so it
// is a POST — a GET link in an email cannot trigger it — and, like every
// action, only owners and admins may run it.
//   curl -X POST -b <session cookie> https://…/api/dev/seed
export async function GET() {
  return NextResponse.json({ error: "Seed with POST (fetch('/api/dev/seed', { method: 'POST' }) from the browser console while signed in)." }, { status: 405 });
}
export async function POST(req: Request) {
  if (!sameOriginRequest(req)) return NextResponse.json({ error: "Cross-site request refused." }, { status: 403 });
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_SEED !== "1") return NextResponse.json({ error: "Seeding is disabled in production (set ALLOW_SEED=1 to override)." }, { status: 403 });
  const ctx = await getCtx();
  if (!ctx) return NextResponse.json({ error: "Sign in first; the demo is created in your workspace." }, { status: 401 });
  if (!(await can({ mandate: ["issue"] }))) return NextResponse.json({ error: "Only owners and admins can seed a workspace." }, { status: 403 });
  const ws = ctx.workspaceId;
  if ((await listAgents(ws)).length > 0) return NextResponse.json({ seeded: false, reason: "Workspace already has agents." });

  const coder = await createAgent(ws, { name: "Claude Code (work laptop)", description: "Buys API credits and developer tools for the side project." });
  const shopper = await createAgent(ws, { name: "Household shopper", description: "Reorders groceries and household supplies." });
  const dev = await createMandate(ws, {
    agentId: coder.id, name: "Dev tooling — Sept 2026", currency: "USD",
    perTxnLimit: 5000, dailyLimit: 15000, totalLimit: 50000, approvalAbove: 2000,
    allowedMerchants: ["OpenAI", "Anthropic", "Vercel*", "GitHub"], blockedCategories: ["gambling", "crypto"],
    activeHoursStart: 0, activeHoursEnd: 24, timezone: "Asia/Kolkata", expiresAt: new Date("2026-09-30T18:29:59.999Z"),
  });
  const home = await createMandate(ws, {
    agentId: shopper.id, name: "Groceries — weekly", currency: "INR",
    perTxnLimit: 400000, dailyLimit: 600000, totalLimit: 2500000, approvalAbove: 250000,
    allowedMerchants: ["BigBasket", "Blinkit", "Zepto"], blockedCategories: ["alcohol"],
    activeHoursStart: 0, activeHoursEnd: 24, timezone: "Asia/Kolkata", expiresAt: null,
  });
  if (!dev.ok || !home.ok) return NextResponse.json({ error: "seed terms invalid" }, { status: 500 });

  const results = [];
  results.push(await authorize(dev.mandate, { amount: 1299, merchant: "OpenAI", purpose: "API credits for the scraper", category: "computer_software_stores" }, "simulation"));
  results.push(await authorize(dev.mandate, { amount: 1900, merchant: "Vercel Pro", purpose: "Hosting, monthly" }, "simulation"));
  results.push(await authorize(dev.mandate, { amount: 9900, merchant: "Anthropic", purpose: "Claude Max upgrade" }, "simulation"));
  results.push(await authorize(dev.mandate, { amount: 4500, merchant: "Anthropic", purpose: "Top-up before the demo" }, "simulation"));
  results.push(await authorize(dev.mandate, { amount: 999, merchant: "Namecheap", purpose: "Domain renewal" }, "simulation"));
  results.push(await authorize(home.mandate, { amount: 184500, merchant: "BigBasket", purpose: "Weekly groceries" }, "simulation"));
  results.push(await authorize(home.mandate, { amount: 320000, merchant: "Blinkit", purpose: "Diwali supplies" }, "simulation"));
  // Two API-rail decisions so the demo shows holds: one captured for less, one still open.
  const seat = await authorize(dev.mandate, { amount: 1500, merchant: "GitHub", purpose: "Copilot seat" }, "agent_api", { actor: `token ${dev.mandate.tokenPrefix}…` });
  if (seat.decision === "approved") await captureTransaction({ mandateId: dev.mandate.id }, seat.transactionId, { amount: 1000, by: "agent", note: "seat prorated" });
  results.push(seat, await authorize(dev.mandate, { amount: 800, merchant: "OpenAI", purpose: "Embeddings batch" }, "agent_api", { actor: `token ${dev.mandate.tokenPrefix}…` }));

  // The newer machinery, so the demo shows it: a team mandate with a veto
  // window and co-signing, a helper delegated out of it, a sandbox, a
  // dispute, an approval route, and the first public anchor.
  const extras: Record<string, unknown> = {};
  try {
    await addRoute(ws, { name: "Big spends → owner", minAmount: 30000, userIds: [ctx.userId], priority: 10 }, ctx.email);
    const booker = await createAgent(ws, { name: "Travel booker", description: "Books flights, hotels and rides for the team offsite." });
    const travel = await createMandate(ws, {
      agentId: booker.id, name: "Offsite travel — Q4", currency: "USD",
      perTxnLimit: 60000, dailyLimit: 150000, totalLimit: 400000, approvalAbove: 20000,
      allowedMerchants: [], blockedCategories: ["gambling"], activeHoursStart: 0, activeHoursEnd: 24, timezone: "Asia/Kolkata", expiresAt: null,
      vetoAbove: 10000, vetoMinutes: 30, cosignAbove: 40000, cosignCount: 2,
    });
    if (travel.ok) {
      const t = travel.mandate;
      await authorize(t, { amount: 8900, merchant: "Uber", purpose: "Airport transfer" }, "agent_api", { actor: `token ${t.tokenPrefix}…` });
      await authorize(t, { amount: 15500, merchant: "MakeMyTrip", purpose: "Hotel, 2 nights, deposit" }, "agent_api", { actor: `token ${t.tokenPrefix}…` }); // veto window
      await authorize(t, { amount: 45200, merchant: "IndiGo", purpose: "6 return fares, offsite" }, "agent_api", { actor: `token ${t.tokenPrefix}…` }); // needs two approvers
      const helper = await delegateMandate(t, { name: "Fare watcher", perTxnLimit: 5000, dailyLimit: 10000, totalLimit: 20000, approvalAbove: 3000, allowedMerchants: ["Skyscanner*", "Google Flights"], agentName: "Fare watcher (sub-agent)", by: `token ${t.tokenPrefix}…` });
      if (helper.ok) { const h = await authorize(helper.mandate, { amount: 1200, merchant: "Skyscanner API", purpose: "Fare alerts, weekly" }, "agent_api", { actor: `token ${helper.mandate.tokenPrefix}…` }); if (h.decision === "approved") await captureTransaction({ mandateId: helper.mandate.id }, h.transactionId, { by: "agent" }); extras.helper = helper.mandate.id; }
      extras.travel = t.id;
    }
    const sandbox = await createMandate(ws, { agentId: coder.id, name: "CI sandbox", currency: "USD", perTxnLimit: 5000, dailyLimit: 15000, totalLimit: 50000, approvalAbove: 2000, allowedMerchants: [], blockedCategories: [], activeHoursStart: 0, activeHoursEnd: 24, timezone: "UTC", expiresAt: null, sandbox: true });
    if (sandbox.ok) { await authorize(sandbox.mandate, { amount: 700, merchant: "OpenAI", purpose: "integration test run" }, "agent_api", { actor: "ci" }); extras.sandbox = sandbox.mandate.id; }
    const grocery = results[5];
    if (grocery.decision === "approved") await openDispute(ws, grocery.transactionId, { reason: "Two items missing from the delivery", by: ctx.email });
    await anchorWorkspace(ws);
  } catch (e) { extras.error = (e as Error).message; }

  return NextResponse.json({ seeded: true, workspace: ws, decisions: results.map((r) => r.decision), tokens: { dev: dev.token, home: home.token }, extras });
}
