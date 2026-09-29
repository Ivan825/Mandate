import { NextRequest, NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron-auth";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

// Housekeeping for tables that only ever grow: idempotency keys past their
// useful life, rate-limit windows, Stripe event ids, expired sessions and
// sign-in tokens. Vercel Cron calls this daily (vercel.json) with
// CRON_SECRET; any scheduler can, with the same bearer.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const out: Record<string, number> = {};
  const run = async (name: string, q: ReturnType<typeof sql>) => { try { const r = await db.execute(q); out[name] = Number(r.rowCount ?? 0); } catch (e) { out[name] = -1; console.error(`cleanup ${name}: ${(e as Error).message}`); } };
  await run("idempotency_keys", sql`delete from idempotency_keys where created_at < now() - interval '7 days'`);
  await run("rate_limits", sql`delete from rate_limits where window_start < extract(epoch from now())::int - 3600`);
  await run("rate_limit", sql`delete from rate_limit where last_request < (extract(epoch from now()) * 1000)::bigint - 86400000`);
  await run("stripe_events", sql`delete from stripe_events where received_at < now() - interval '30 days'`);
  await run("sessions", sql`delete from session where expires_at < now()`);
  await run("verifications", sql`delete from verification where expires_at < now()`);
  await run("approvals_expired_flag", sql`update approvals set status = 'expired' where status = 'approved' and expires_at is not null and expires_at < now()`);
  await run("webhook_deliveries", sql`delete from webhook_deliveries where created_at < now() - interval '30 days'`);
  await run("oauth_access_tokens", sql`delete from oauth_access_token where expires_at < now() - interval '1 day'`);
  await run("oauth_refresh_tokens", sql`delete from oauth_refresh_token where expires_at < now() - interval '1 day'`);
  await run("proxy_calls", sql`delete from proxy_calls where created_at < now() - interval '400 days'`);
  await run("push_subscriptions_dead", sql`delete from push_subscriptions where failures >= 5`);
  // Show-once plaintexts older than their window, even on a quiet deployment.
  try { const { sweepReveals } = await import("@/lib/reveal"); await sweepReveals(); out.reveals_swept = 0; } catch (e) { out.reveals_swept = -1; console.error(`cleanup reveals: ${(e as Error).message}`); }
  // Holds nobody settled, across every workspace (each workspace also sweeps
  // its own on every authorisation, so this is the backstop for idle ones).
  try { const { sweepAllHolds } = await import("@/lib/service"); out.holds_closed = await sweepAllHolds(500); } catch (e) { out.holds_closed = -1; console.error(`cleanup holds: ${(e as Error).message}`); }
  try { const { anchorAll } = await import("@/lib/anchors"); out.ledgers_anchored = await anchorAll(); } catch (e) { out.ledgers_anchored = -1; console.error(`cleanup anchors: ${(e as Error).message}`); }
  try { const { dispatchDue } = await import("@/lib/webhooks"); out.webhooks_dispatched = (await dispatchDue({ limit: 200, budgetMs: 40_000 })).sent; } catch (e) { out.webhooks_dispatched = -1; console.error(`cleanup webhooks: ${(e as Error).message}`); }
  return NextResponse.json({ ok: true, deleted: out, at: new Date().toISOString() });
}
