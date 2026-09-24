import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "./db";
import type { PushSubscription } from "./schema";

// Web Push to the browsers and phones a person turned it on in. Needs a
// VAPID key pair (npx web-push generate-vapid-keys) in VAPID_PUBLIC_KEY /
// VAPID_PRIVATE_KEY and a VAPID_SUBJECT (mailto: or https: URL). Without
// them push is simply off and the Settings page says so.

export function pushEnabled(): boolean { return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY); }
export function vapidPublicKey(): string | null { return process.env.VAPID_PUBLIC_KEY ?? null; }

type WebPush = typeof import("web-push");
let wp: WebPush | null = null;
async function lib(): Promise<WebPush | null> {
  if (!pushEnabled()) return null;
  if (!wp) {
    wp = (await import("web-push")).default ?? (await import("web-push"));
    wp.setVapidDetails(process.env.VAPID_SUBJECT ?? "mailto:hello@example.com", process.env.VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!);
  }
  return wp;
}

export type SubscriptionInput = { endpoint: string; keys: { p256dh: string; auth: string } };

export async function subscribe(userId: string, sub: SubscriptionInput, userAgent: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) return { ok: false, error: "Not a valid push subscription." };
  const [count] = await db.select({ c: sql<number>`count(*)::int` }).from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.userId, userId));
  if (Number(count?.c ?? 0) >= 10) return { ok: false, error: "You already have ten devices; remove one in Settings." };
  const row: PushSubscription = { id: randomUUID(), userId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, userAgent: userAgent.slice(0, 200), createdAt: new Date(), lastUsedAt: null, failures: 0 };
  await db.insert(schema.pushSubscriptions).values(row).onConflictDoUpdate({ target: schema.pushSubscriptions.endpoint, set: { userId, p256dh: row.p256dh, auth: row.auth, userAgent: row.userAgent, failures: 0 } });
  return { ok: true, id: row.id };
}

export async function unsubscribe(userId: string, endpointOrId: string) {
  await db.delete(schema.pushSubscriptions).where(and(eq(schema.pushSubscriptions.userId, userId), sql`(${schema.pushSubscriptions.endpoint} = ${endpointOrId} or ${schema.pushSubscriptions.id} = ${endpointOrId})`));
}

export async function listSubscriptions(userId: string): Promise<PushSubscription[]> {
  return db.select().from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.userId, userId));
}

export type PushPayload = { title: string; body: string; tag?: string; url?: string; inboxUrl?: string; approveUrl?: string; denyUrl?: string };

// Send to every device of every listed person. Dead subscriptions (the
// browser said 404/410) are removed; other failures count and five in a
// row also remove it.
export async function sendPush(userIds: string[], payload: PushPayload): Promise<{ sent: number; failed: number; devices: number }> {
  const w = await lib();
  if (!w || userIds.length === 0) return { sent: 0, failed: 0, devices: 0 };
  const subs = await db.select().from(schema.pushSubscriptions).where(inArray(schema.pushSubscriptions.userId, userIds));
  let sent = 0, failed = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await w.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 24 * 3600, urgency: payload.approveUrl ? "high" : "normal", timeout: 8000 });
      sent++;
      await db.update(schema.pushSubscriptions).set({ lastUsedAt: new Date(), failures: 0 }).where(eq(schema.pushSubscriptions.id, s.id));
    } catch (e) {
      failed++;
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410 || s.failures + 1 >= 5) await db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.id, s.id));
      else await db.update(schema.pushSubscriptions).set({ failures: s.failures + 1 }).where(eq(schema.pushSubscriptions.id, s.id));
    }
  }));
  return { sent, failed, devices: subs.length };
}
