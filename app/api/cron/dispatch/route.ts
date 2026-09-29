import { NextRequest, NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron-auth";

// For deployments whose cron can run more often than daily (cron-job.org,
// GitHub Actions, a systemd timer): deliver due webhooks and close expired
// holds. Same bearer as the cleanup job. Safe to call every minute; it does
// nothing when nothing is due.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const out: Record<string, unknown> = {};
  try { const { dispatchDue } = await import("@/lib/webhooks"); out.webhooks = await dispatchDue({ limit: 200, budgetMs: 45_000 }); } catch (e) { out.webhooks = (e as Error).message; }
  try { const { sweepAllHolds } = await import("@/lib/service"); out.holdsClosed = await sweepAllHolds(500); } catch (e) { out.holdsClosed = (e as Error).message; }
  return NextResponse.json({ ok: true, ...out, at: new Date().toISOString() });
}
