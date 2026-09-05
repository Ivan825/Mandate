import { createHmac, timingSafeEqual } from "node:crypto";
import { and, isNotNull, lt, sql } from "drizzle-orm";
import { db, schema } from "./db";

// "Shown once" credentials. The action that creates a credential redirects
// with a short-lived signed grant in the URL; the page shows the plaintext
// only while the grant is valid, and any page load clears plaintexts older
// than the grant window. This survives the double render Next performs
// after a server-action redirect, and never shows a token later.

export const REVEAL_WINDOW_MS = 90_000;

function secret() { return process.env.NOTIFY_SECRET ?? process.env.BETTER_AUTH_SECRET ?? "dev"; }

export function grant(id: string): string {
  const exp = Date.now() + REVEAL_WINDOW_MS;
  return `${exp}.${createHmac("sha256", secret()).update(`reveal|${id}|${exp}`).digest("base64url")}`;
}

export function grantValid(id: string, g: string | undefined): boolean {
  if (!g) return false;
  const [expStr, sig] = g.split(".");
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp || !sig) return false;
  const expected = createHmac("sha256", secret()).update(`reveal|${id}|${exp}`).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function sweepReveals() {
  const cutoff = new Date(Date.now() - REVEAL_WINDOW_MS);
  await db.update(schema.mandates).set({ tokenReveal: null }).where(and(isNotNull(schema.mandates.tokenReveal), lt(schema.mandates.createdAt, cutoff)));
  await db.update(schema.proxyKeys).set({ tokenReveal: null }).where(and(isNotNull(schema.proxyKeys.tokenReveal), lt(schema.proxyKeys.createdAt, cutoff)));
  void sql;
}
