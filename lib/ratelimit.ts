import { sql } from "drizzle-orm";
import { db } from "./db";

// Fixed-window rate limiting in Postgres so it holds across serverless
// instances. One row per (key, minute); the upsert returns the new count.
//   agent endpoints: 120/min per token, 600/min per IP
//   proxy:           300/min per key
//   one-tap/consent: 30/min per IP

export async function rateLimit(key: string, limit: number, windowSec = 60): Promise<{ ok: boolean; remaining: number; resetSec: number }> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSec);
  const id = `${key}:${windowStart}`;
  try {
    const r = await db.execute(sql`insert into rate_limits (id, window_start, count) values (${id}, ${windowStart}, 1)
      on conflict (id) do update set count = rate_limits.count + 1 returning count`);
    const count = Number((r.rows[0] as { count: number }).count);
    // Opportunistic cleanup of old windows, cheap and occasional.
    if (count === 1 && Math.random() < 0.05) await db.execute(sql`delete from rate_limits where window_start < ${windowStart - 3600}`);
    return { ok: count <= limit, remaining: Math.max(0, limit - count), resetSec: windowStart + windowSec - now };
  } catch {
    return { ok: true, remaining: limit, resetSec: windowSec }; // never fail closed on the limiter itself
  }
}

// The address the platform's edge saw. Forwarding headers are trusted only
// when something trustworthy sets them: on Vercel (which overwrites x-real-ip
// and appends to x-forwarded-for), or when TRUST_PROXY=true says a reverse
// proxy in front of `node server.js` does the same. Anywhere else a client
// could write those headers itself and hop between buckets, so every request
// shares one bucket — coarser, but not forgeable. Outside production the
// headers are trusted so local tests behave like the hosted app.
export function trustForwardingHeaders(): boolean {
  const t = process.env.TRUST_PROXY;
  if (t === "false" || t === "0") return false;
  if (t === "true" || t === "1") return true;
  return Boolean(process.env.VERCEL) || process.env.NODE_ENV !== "production";
}
export function clientIp(req: Request): string {
  const h = req.headers;
  if (!trustForwardingHeaders()) return "direct";
  const real = (h.get("x-real-ip") ?? "").trim();
  if (real) return real;
  const fwd = (h.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return fwd.at(-1) || "unknown";
}
