import { NextResponse } from "next/server";
import { createAgent, createMandate, authorize, listAgents } from "@/lib/service";

// Populates a demo state so the first open shows the product working.
// Only runs on an empty database. GET /api/dev/seed
export async function GET() {
  if ((await listAgents()).length > 0) return NextResponse.json({ seeded: false, reason: "Database already has agents." });

  const coder = await createAgent({ name: "Claude Code (work laptop)", description: "Buys API credits and developer tools for the side project." });
  const shopper = await createAgent({ name: "Household shopper", description: "Reorders groceries and household supplies." });

  const dev = await createMandate({
    agentId: coder.id, name: "Dev tooling — Sept 2026", currency: "USD",
    perTxnLimit: 5000, dailyLimit: 10000, totalLimit: 50000, approvalAbove: 2000,
    allowedMerchants: ["OpenAI", "Anthropic", "Vercel*", "GitHub"], blockedCategories: ["gambling", "crypto"],
    activeHoursStart: 0, activeHoursEnd: 24, timezone: "Asia/Kolkata", expiresAt: new Date("2026-09-30T23:59:59Z"),
  });
  const home = await createMandate({
    agentId: shopper.id, name: "Groceries — weekly", currency: "INR",
    perTxnLimit: 400000, dailyLimit: 600000, totalLimit: 2500000, approvalAbove: 250000,
    allowedMerchants: ["BigBasket", "Blinkit", "Zepto"], blockedCategories: ["alcohol"],
    activeHoursStart: 7, activeHoursEnd: 23, timezone: "Asia/Kolkata", expiresAt: null,
  });

  const results = [];
  results.push(await authorize(dev, { amount: 1299, merchant: "OpenAI", purpose: "API credits for the scraper", category: "computer_software_stores" }, "simulation"));
  results.push(await authorize(dev, { amount: 1900, merchant: "Vercel Pro", purpose: "Hosting, monthly" }, "simulation"));
  results.push(await authorize(dev, { amount: 9900, merchant: "Anthropic", purpose: "Claude Max upgrade" }, "simulation")); // over per-txn → declined
  results.push(await authorize(dev, { amount: 4500, merchant: "Anthropic", purpose: "Top-up before the demo" }, "simulation")); // above ask threshold → pending
  results.push(await authorize(dev, { amount: 999, merchant: "Namecheap", purpose: "Domain renewal" }, "simulation")); // merchant not allowed → declined
  results.push(await authorize(home, { amount: 184500, merchant: "BigBasket", purpose: "Weekly groceries" }, "simulation"));
  results.push(await authorize(home, { amount: 320000, merchant: "Blinkit", purpose: "Diwali supplies" }, "simulation")); // above ask threshold → pending

  return NextResponse.json({ seeded: true, agents: 2, mandates: 2, decisions: results.map((r) => r.decision) });
}
