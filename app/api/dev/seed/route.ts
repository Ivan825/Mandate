import { NextResponse } from "next/server";
import { getCtx, can } from "@/lib/session";
import { createAgent, createMandate, authorize, listAgents } from "@/lib/service";

// Populates the signed-in user's workspace with a demo state. Development
// only (or ALLOW_SEED=1); runs once per empty workspace. It mutates, so it
// is a POST — a GET link in an email cannot trigger it — and, like every
// action, only owners and admins may run it.
//   curl -X POST -b <session cookie> https://…/api/dev/seed
export async function GET() {
  return NextResponse.json({ error: "Seed with POST (fetch('/api/dev/seed', { method: 'POST' }) from the browser console while signed in)." }, { status: 405 });
}
export async function POST() {
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
    perTxnLimit: 5000, dailyLimit: 10000, totalLimit: 50000, approvalAbove: 2000,
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

  return NextResponse.json({ seeded: true, workspace: ws, decisions: results.map((r) => r.decision), tokens: { dev: dev.token, home: home.token } });
}
