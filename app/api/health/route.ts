import { NextResponse, after } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

// Uptime health check. A plain GET answers from the process alone and never
// touches Postgres: a monitor that pings every minute would otherwise keep a
// scale-to-zero database (Neon's free plan suspends after 5 idle minutes)
// awake around the clock and burn its whole monthly compute allowance in
// about seventeen days — which takes the site down with it.
//
// GET /api/health?deep=1 also checks the database and runs a little
// housekeeping (due webhook retries, expired holds, reveal sweeps, the daily
// anchor). Call that from a scheduler no more often than every 20 minutes;
// on Vercel the daily cron (/api/cron/cleanup) already covers it.
export const dynamic = "force-dynamic";

// Even the deep ping is throttled per instance so a misconfigured monitor
// cannot turn it into a hot loop.
let lastDeep = 0;
const DEEP_INTERVAL_MS = 15 * 60_000;

export async function GET(req: Request) {
  const deep = new URL(req.url).searchParams.get("deep") === "1";
  const headers = { "cache-control": "no-store" };
  if (!deep) return NextResponse.json({ ok: true }, { headers });
  try {
    await db.execute(sql`select 1`);
    if (Date.now() - lastDeep < DEEP_INTERVAL_MS) return NextResponse.json({ ok: true, db: true, housekeeping: "skipped" }, { headers });
    lastDeep = Date.now();
    after(async () => {
      try { const { sweepReveals } = await import("@/lib/reveal"); await sweepReveals(); } catch (e) { console.error("health: reveals", (e as Error).message); }
      try { const { dispatchDue } = await import("@/lib/webhooks"); await dispatchDue({ limit: 10, budgetMs: 8000 }); } catch (e) { console.error("health: webhooks", (e as Error).message); }
      try { const { sweepAllHolds } = await import("@/lib/service"); await sweepAllHolds(50); } catch (e) { console.error("health: holds", (e as Error).message); }
      try { const { anchorIfDue } = await import("@/lib/anchors"); await anchorIfDue(); } catch (e) { console.error("health: anchors", (e as Error).message); }
    });
    return NextResponse.json({ ok: true, db: true, housekeeping: "ran" }, { headers });
  } catch {
    return NextResponse.json({ ok: false, db: false }, { status: 503, headers });
  }
}
