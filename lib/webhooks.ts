import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { db, schema, type Tx } from "./db";
import { encrypt, decrypt } from "./crypto";
import { canonical } from "./ledger";
import { webhookProblem } from "./notify";
import { describeEvent } from "./activity";
import type { WebhookEndpoint, WebhookDelivery } from "./schema";

// Event webhooks: every ledger event, pushed to the workspace's own
// endpoints as a signed JSON POST. Distinct from notification channels
// (lib/notify.ts), which are per person and carry approve/deny links —
// these are per workspace and carry the event itself, for n8n, Zapier, a
// finance system, or a dashboard someone builds.
//
// Delivery rows are queued in the same transaction as the ledger row
// (ledger.appendEvent calls enqueue), so an event is never announced
// before it is durable. Sending happens after the request (kick), and
// anything that fails is retried with backoff by whichever request next
// runs dispatchDue: the health check, the cron, or a page load.
//
// Signature (Stripe-style):  Mandate-Signature: t=<unix seconds>,v1=<hex hmac-sha256(secret, `${t}.${body}`)>

export const MAX_ENDPOINTS = 10;
export const MAX_ATTEMPTS = 6;
const BACKOFF_S = [60, 300, 1800, 7200, 43200]; // after attempt 1..5; attempt 6 is the last
const DISABLE_AFTER_FAILURES = 25;
const TIMEOUT_MS = 8000;

export type EventFilter = "*" | string[];

export function parseFilter(s: string): EventFilter {
  if (s.trim() === "*" || !s.trim()) return "*";
  try { const v = JSON.parse(s); return Array.isArray(v) && v.length ? v.map(String) : "*"; } catch { return "*"; }
}

// "authorization." matches every authorization.* event; "approval.approved" one type.
export function filterMatches(filter: EventFilter, type: string): boolean {
  if (filter === "*") return true;
  return filter.some((f) => f === type || (f.endsWith(".") && type.startsWith(f)) || (f.endsWith("*") && type.startsWith(f.slice(0, -1))));
}

export function normaliseFilter(raw: string): EventFilter {
  const parts = raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0 || parts.includes("*")) return "*";
  return [...new Set(parts.map((p) => p.toLowerCase().replace(/[^a-z0-9_.*]/g, "")).filter(Boolean))].slice(0, 40);
}

export function newSecret(): string { return "whsec_" + randomBytes(24).toString("base64url"); }

export function sign(secret: string, body: string, t = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

// For receivers (and the docs): true when the header was produced with this
// secret for this body within the tolerance.
export function verifySignature(secret: string, body: string, header: string, toleranceS = 300, now = Math.floor(Date.now() / 1000)): boolean {
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(now - t) > toleranceS || !parts.v1) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${body}`).digest("hex"));
  const given = Buffer.from(parts.v1);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// ---------- Endpoints ----------

export async function listEndpoints(workspaceId: string): Promise<WebhookEndpoint[]> {
  return db.select().from(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.workspaceId, workspaceId)).orderBy(desc(schema.webhookEndpoints.createdAt));
}

export async function addEndpoint(workspaceId: string, input: { url: string; description?: string; events?: string }, by: string): Promise<{ ok: true; endpoint: WebhookEndpoint; secret: string } | { ok: false; error: string }> {
  const url = input.url.trim();
  const problem = await webhookProblem(url);
  if (problem) return { ok: false, error: problem };
  const [count] = await db.select({ c: sql<number>`count(*)::int` }).from(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.workspaceId, workspaceId));
  if (Number(count?.c ?? 0) >= MAX_ENDPOINTS) return { ok: false, error: `A workspace can have ${MAX_ENDPOINTS} endpoints; remove one first.` };
  const secret = newSecret();
  const filter = normaliseFilter(input.events ?? "*");
  const row: WebhookEndpoint = {
    id: randomUUID(), workspaceId, url, description: (input.description ?? "").trim().slice(0, 80), secretCiphertext: encrypt(secret), secretHint: secret.slice(-4),
    events: filter === "*" ? "*" : JSON.stringify(filter), enabled: 1, consecutiveFailures: 0, lastDeliveryAt: null, lastStatus: null, disabledReason: null, createdBy: by, createdAt: new Date(),
  };
  await db.transaction(async (tx) => {
    await tx.insert(schema.webhookEndpoints).values(row);
    const { appendEvent } = await import("./ledger");
    await appendEvent(tx, workspaceId, "webhook.endpoint_added", { endpointId: row.id, url, events: filter, by });
  });
  return { ok: true, endpoint: row, secret };
}

export async function rotateEndpointSecret(workspaceId: string, id: string, by: string): Promise<string | null> {
  const secret = newSecret();
  const r = await db.update(schema.webhookEndpoints).set({ secretCiphertext: encrypt(secret), secretHint: secret.slice(-4) }).where(and(eq(schema.webhookEndpoints.id, id), eq(schema.webhookEndpoints.workspaceId, workspaceId))).returning({ id: schema.webhookEndpoints.id });
  if (!r.length) return null;
  const { recordEvent } = await import("./ledger");
  await recordEvent(workspaceId, "webhook.secret_rotated", { endpointId: id, by });
  return secret;
}

export async function setEndpointEnabled(workspaceId: string, id: string, enabled: boolean, by: string) {
  const r = await db.update(schema.webhookEndpoints).set(enabled ? { enabled: 1, consecutiveFailures: 0, disabledReason: null } : { enabled: 0, disabledReason: "paused by " + by }).where(and(eq(schema.webhookEndpoints.id, id), eq(schema.webhookEndpoints.workspaceId, workspaceId))).returning({ id: schema.webhookEndpoints.id });
  if (r.length) { const { recordEvent } = await import("./ledger"); await recordEvent(workspaceId, enabled ? "webhook.endpoint_enabled" : "webhook.endpoint_paused", { endpointId: id, by }); }
}

export async function removeEndpoint(workspaceId: string, id: string, by: string) {
  const r = await db.delete(schema.webhookEndpoints).where(and(eq(schema.webhookEndpoints.id, id), eq(schema.webhookEndpoints.workspaceId, workspaceId))).returning({ id: schema.webhookEndpoints.id });
  if (r.length) { const { recordEvent } = await import("./ledger"); await recordEvent(workspaceId, "webhook.endpoint_removed", { endpointId: id, by }); }
}

export async function recentDeliveries(workspaceId: string, limit = 30): Promise<(WebhookDelivery & { url: string })[]> {
  const rows = await db.select({ d: schema.webhookDeliveries, url: schema.webhookEndpoints.url }).from(schema.webhookDeliveries)
    .innerJoin(schema.webhookEndpoints, eq(schema.webhookEndpoints.id, schema.webhookDeliveries.endpointId))
    .where(eq(schema.webhookDeliveries.workspaceId, workspaceId)).orderBy(desc(schema.webhookDeliveries.createdAt)).limit(limit);
  return rows.map((r) => ({ ...r.d, url: r.url }));
}

// ---------- Queueing ----------

export type EventEnvelope = { id: string; type: string; seq: number; hash: string; workspaceId: string; createdAt: string; summary: string; data: Record<string, unknown> };

// Called by ledger.appendEvent inside its transaction. Returns how many
// deliveries were queued so the caller can kick the sender.
export async function enqueue(tx: Tx, workspaceId: string, ev: { id: string; type: string; seq: number; hash: string; createdAt: Date; payload: Record<string, unknown> }): Promise<number> {
  const endpoints = await tx.select().from(schema.webhookEndpoints).where(and(eq(schema.webhookEndpoints.workspaceId, workspaceId), eq(schema.webhookEndpoints.enabled, 1)));
  const targets = endpoints.filter((e) => filterMatches(parseFilter(e.events), ev.type));
  if (targets.length === 0) return 0;
  const envelope: EventEnvelope = { id: `evt_${ev.id}`, type: ev.type, seq: ev.seq, hash: ev.hash, workspaceId, createdAt: ev.createdAt.toISOString(), summary: describeEvent(ev.type, ev.payload).summary, data: ev.payload };
  const body = canonical(envelope);
  const now = new Date();
  await tx.insert(schema.webhookDeliveries).values(targets.map((e) => ({ id: randomUUID(), workspaceId, endpointId: e.id, eventId: ev.id, eventType: ev.type, ledgerSeq: ev.seq, body, status: "pending", attempts: 0, nextAttemptAt: now, lastStatusCode: null, lastError: null, createdAt: now, deliveredAt: null })));
  return targets.length;
}

// Sends run after the response that created the event; on a platform that
// freezes the function once the response is out, next/server's after()
// keeps it alive. Outside a request (tests, scripts) a short timer will do.
export function kick() {
  const run = () => dispatchDue({ limit: 20, budgetMs: 20_000 }).catch((e) => console.error("webhook dispatch:", (e as Error).message));
  import("next/server").then(({ after }) => { try { after(run); } catch { setTimeout(run, 250); } }).catch(() => setTimeout(run, 250));
}

// ---------- Sending ----------

export type DispatchResult = { picked: number; sent: number; failed: number };

// Deliver what is due. Rows are claimed with SKIP LOCKED, so two dispatchers
// (a page load and the cron) never send the same delivery twice.
export async function dispatchDue(opts: { limit?: number; budgetMs?: number; endpointId?: string } = {}): Promise<DispatchResult> {
  const limit = opts.limit ?? 20;
  const started = Date.now();
  const budget = opts.budgetMs ?? 20_000;
  const now = new Date();
  const claimed = await db.transaction(async (tx) => {
    const rows = await tx.select().from(schema.webhookDeliveries)
      .where(and(eq(schema.webhookDeliveries.status, "pending"), lte(schema.webhookDeliveries.nextAttemptAt, now), opts.endpointId ? eq(schema.webhookDeliveries.endpointId, opts.endpointId) : undefined))
      .orderBy(asc(schema.webhookDeliveries.nextAttemptAt)).limit(limit).for("update", { skipLocked: true });
    if (rows.length === 0) return [];
    // Push the next attempt out while we work on them, so a crash mid-send
    // does not leave them claimable by everyone at once.
    await tx.update(schema.webhookDeliveries).set({ nextAttemptAt: new Date(now.getTime() + 60_000) }).where(inArray(schema.webhookDeliveries.id, rows.map((r) => r.id)));
    return rows;
  });
  const result: DispatchResult = { picked: claimed.length, sent: 0, failed: 0 };
  if (claimed.length === 0) return result;
  const endpointIds = [...new Set(claimed.map((d) => d.endpointId))];
  const endpoints = new Map((await db.select().from(schema.webhookEndpoints).where(inArray(schema.webhookEndpoints.id, endpointIds))).map((e) => [e.id, e]));
  // Group by endpoint and send in order per endpoint, endpoints in parallel.
  const byEndpoint = new Map<string, WebhookDelivery[]>();
  for (const d of claimed) byEndpoint.set(d.endpointId, [...(byEndpoint.get(d.endpointId) ?? []), d]);
  await Promise.all([...byEndpoint.entries()].map(async ([endpointId, deliveries]) => {
    const ep = endpoints.get(endpointId);
    for (const d of deliveries.sort((a, b) => a.ledgerSeq - b.ledgerSeq)) {
      if (Date.now() - started > budget) { await db.update(schema.webhookDeliveries).set({ nextAttemptAt: new Date() }).where(eq(schema.webhookDeliveries.id, d.id)); continue; }
      if (!ep || !ep.enabled) { await db.update(schema.webhookDeliveries).set({ status: "failed", lastError: "endpoint disabled" }).where(eq(schema.webhookDeliveries.id, d.id)); result.failed++; continue; }
      const outcome = await sendOne(ep, d);
      if (outcome.ok) result.sent++; else result.failed++;
    }
  }));
  return result;
}

async function sendOne(ep: WebhookEndpoint, d: WebhookDelivery): Promise<{ ok: boolean }> {
  const attempt = d.attempts + 1;
  let statusCode: number | null = null;
  let error: string | null = null;
  try {
    const problem = await webhookProblem(ep.url);
    if (problem) throw new Error(problem);
    const secret = decrypt(ep.secretCiphertext);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(ep.url, {
        method: "POST", redirect: "manual", signal: ctrl.signal, body: d.body,
        headers: { "content-type": "application/json", "user-agent": "Mandate-Webhook/1", "mandate-signature": sign(secret, d.body), "mandate-event": d.eventType, "mandate-delivery": d.id, "mandate-event-id": `evt_${d.eventId}`, "idempotency-key": d.id },
      });
      statusCode = res.status;
      if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
    } finally { clearTimeout(timer); }
  } catch (e) {
    error = (e as Error).name === "AbortError" ? `timeout after ${TIMEOUT_MS / 1000}s` : (e as Error).message;
  }
  const now = new Date();
  if (!error) {
    await db.transaction(async (tx) => {
      await tx.update(schema.webhookDeliveries).set({ status: "delivered", attempts: attempt, lastStatusCode: statusCode, lastError: null, deliveredAt: now }).where(eq(schema.webhookDeliveries.id, d.id));
      await tx.update(schema.webhookEndpoints).set({ consecutiveFailures: 0, lastDeliveryAt: now, lastStatus: statusCode }).where(eq(schema.webhookEndpoints.id, ep.id));
    });
    return { ok: true };
  }
  const final = attempt >= MAX_ATTEMPTS;
  const next = final ? now : new Date(now.getTime() + (BACKOFF_S[attempt - 1] ?? 43200) * 1000);
  await db.transaction(async (tx) => {
    await tx.update(schema.webhookDeliveries).set({ status: final ? "failed" : "pending", attempts: attempt, lastStatusCode: statusCode, lastError: error!.slice(0, 200), nextAttemptAt: next }).where(eq(schema.webhookDeliveries.id, d.id));
    const [e2] = await tx.update(schema.webhookEndpoints).set({ consecutiveFailures: sql`${schema.webhookEndpoints.consecutiveFailures} + 1`, lastDeliveryAt: now, lastStatus: statusCode }).where(eq(schema.webhookEndpoints.id, ep.id)).returning({ failures: schema.webhookEndpoints.consecutiveFailures });
    if (e2 && e2.failures >= DISABLE_AFTER_FAILURES) {
      await tx.update(schema.webhookEndpoints).set({ enabled: 0, disabledReason: `disabled after ${e2.failures} consecutive failures (last: ${error})` }).where(eq(schema.webhookEndpoints.id, ep.id));
      const { appendEvent } = await import("./ledger");
      await appendEvent(tx, ep.workspaceId, "webhook.endpoint_disabled", { endpointId: ep.id, url: ep.url, failures: e2.failures, lastError: error });
    }
  });
  return { ok: false };
}

// A hand-made event so the person can see the shape and check their
// signature code before anything real happens.
export async function sendTestEvent(workspaceId: string, endpointId: string, by: string): Promise<{ ok: boolean; status?: number | null; error?: string | null }> {
  const [ep] = await db.select().from(schema.webhookEndpoints).where(and(eq(schema.webhookEndpoints.id, endpointId), eq(schema.webhookEndpoints.workspaceId, workspaceId))).limit(1);
  if (!ep) return { ok: false, error: "No such endpoint." };
  const now = new Date();
  const envelope: EventEnvelope = { id: `evt_test_${randomUUID()}`, type: "test", seq: 0, hash: "", workspaceId, createdAt: now.toISOString(), summary: `Test event sent by ${by}`, data: { message: "Mandate can reach this endpoint.", by } };
  const d: WebhookDelivery = { id: randomUUID(), workspaceId, endpointId: ep.id, eventId: "test", eventType: "test", ledgerSeq: 0, body: canonical(envelope), status: "pending", attempts: 0, nextAttemptAt: now, lastStatusCode: null, lastError: null, createdAt: now, deliveredAt: null };
  await db.insert(schema.webhookDeliveries).values(d);
  const r = await sendOne(ep, d);
  const [after] = await db.select({ code: schema.webhookDeliveries.lastStatusCode, err: schema.webhookDeliveries.lastError }).from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.id, d.id)).limit(1);
  return { ok: r.ok, status: after?.code ?? null, error: after?.err ?? null };
}

export async function retryDelivery(workspaceId: string, id: string) {
  await db.update(schema.webhookDeliveries).set({ status: "pending", nextAttemptAt: new Date(), attempts: sql`least(${schema.webhookDeliveries.attempts}, ${MAX_ATTEMPTS - 1})` }).where(and(eq(schema.webhookDeliveries.id, id), eq(schema.webhookDeliveries.workspaceId, workspaceId)));
  await dispatchDue({ limit: 5, budgetMs: 10_000 });
}
