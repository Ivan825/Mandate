import { NextResponse, after } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

// Load-balancer and uptime health check: the process is up and the database
// answers. No auth, no cookies, nothing about the deployment leaks.
//
// It also does a little housekeeping after answering: a handful of due
// webhook retries and expired holds. On a serverless host with a daily cron
// this is what turns an uptime monitor's five-minute ping into a scheduler.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db.execute(sql`select 1`);
    after(async () => {
      try { const { dispatchDue } = await import("@/lib/webhooks"); await dispatchDue({ limit: 10, budgetMs: 8000 }); } catch (e) { console.error("health: webhooks", (e as Error).message); }
      try { const { sweepAllHolds } = await import("@/lib/service"); await sweepAllHolds(50); } catch (e) { console.error("health: holds", (e as Error).message); }
    });
    return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
