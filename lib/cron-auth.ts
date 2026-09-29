import { createHash, timingSafeEqual } from "node:crypto";

// Constant-time check of the scheduler's bearer against CRON_SECRET.
export function cronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const a = createHash("sha256").update(given).digest(), b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}
