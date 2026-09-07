import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

// Housekeeping for tables that only ever grow: idempotency keys past their
// useful life, rate-limit windows, Stripe event ids, expired sessions and
// sign-in tokens. Vercel Cron calls this daily (vercel.json) with
// CRON_SECRET; any scheduler can, with the same bearer.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const out: Record<string, number> = {};
  const run = async (name: string, q: ReturnType<typeof sql>) => { try { const r = await db.execute(q); out[name] = Number(r.rowCount ?? 0); } catch (e) { out[name] = -1; console.error(`cleanup ${name}: ${(e as Error).message}`); } };
  await run("idempotency_keys", sql`delete from idempotency_keys where created_at < now() - interval '7 days'`);
  await run("rate_limits", sql`delete from rate_limits where window_start < extract(epoch from now())::int - 3600`);
  await run("rate_limit", sql`delete from rate_limit where last_request < (extract(epoch from now()) * 1000)::bigint - 86400000`);
  await run("stripe_events", sql`delete from stripe_events where received_at < now() - interval '30 days'`);
  await run("sessions", sql`delete from session where expires_at < now()`);
  await run("verifications", sql`delete from verification where expires_at < now()`);
  await run("approvals_expired_flag", sql`update approvals set status = 'expired' where status = 'approved' and expires_at is not null and expires_at < now()`);
  return NextResponse.json({ ok: true, deleted: out, at: new Date().toISOString() });
}
