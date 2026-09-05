import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "./db";
import { appendEvent } from "./ledger";
import { encrypt, decrypt } from "./crypto";
import { authorize, getMandate, type AuthResult } from "./service";
import { costCents, estimateTokens, priceFor, type Provider } from "./pricing";
import type { Mandate } from "./schema";

// The API-key proxy. An agent points its OpenAI / Anthropic / Gemini SDK at
// Mandate with a proxy key instead of the real key. Each call is priced
// from the request (prompt size and max output tokens), pre-authorised
// against the mandate exactly like a purchase, forwarded with the real key,
// and settled on the provider's reported usage. Streaming responses are
// passed through and settled when the stream ends.

export const PROVIDERS: Record<Provider, { name: string; base: string; authHeader: (key: string) => Record<string, string>; defaultMaxOut: number }> = {
  openai: { name: "OpenAI", base: process.env.PROXY_UPSTREAM_OPENAI ?? "https://api.openai.com/v1", authHeader: (k) => ({ authorization: `Bearer ${k}` }), defaultMaxOut: 4096 },
  anthropic: { name: "Anthropic", base: process.env.PROXY_UPSTREAM_ANTHROPIC ?? "https://api.anthropic.com/v1", authHeader: (k) => ({ "x-api-key": k }), defaultMaxOut: 4096 },
  gemini: { name: "Google Gemini", base: process.env.PROXY_UPSTREAM_GEMINI ?? "https://generativelanguage.googleapis.com/v1beta", authHeader: (k) => ({ "x-goog-api-key": k }), defaultMaxOut: 8192 },
};

export function isProvider(s: string): s is Provider { return s === "openai" || s === "anthropic" || s === "gemini"; }

// ---------- Provider keys ----------

export async function addProviderKey(workspaceId: string, provider: Provider, rawKey: string, label: string, by: string) {
  const k = rawKey.trim();
  if (k.length < 16) throw new Error("That doesn't look like an API key.");
  const row = { id: randomUUID(), workspaceId, provider, label: label.trim().slice(0, 40), ciphertext: encrypt(k), hint: k.slice(-4), createdBy: by, createdAt: new Date() };
  await db.transaction(async (tx) => {
    await tx.insert(schema.providerKeys).values(row);
    await appendEvent(tx, workspaceId, "proxy.provider_key_added", { providerKeyId: row.id, provider, label: row.label, hint: row.hint, by });
  });
  return row;
}

export async function listProviderKeys(workspaceId: string) {
  return db.select({ id: schema.providerKeys.id, provider: schema.providerKeys.provider, label: schema.providerKeys.label, hint: schema.providerKeys.hint, createdAt: schema.providerKeys.createdAt })
    .from(schema.providerKeys).where(eq(schema.providerKeys.workspaceId, workspaceId)).orderBy(desc(schema.providerKeys.createdAt));
}

export async function removeProviderKey(workspaceId: string, id: string, by: string) {
  await db.transaction(async (tx) => {
    const r = await tx.delete(schema.providerKeys).where(and(eq(schema.providerKeys.id, id), eq(schema.providerKeys.workspaceId, workspaceId))).returning({ id: schema.providerKeys.id });
    if (r.length) await appendEvent(tx, workspaceId, "proxy.provider_key_removed", { providerKeyId: id, by });
  });
}

// ---------- Proxy keys ----------

function newProxyToken() { return "mpx_" + randomBytes(24).toString("base64url"); }
function hash(t: string) { return createHash("sha256").update(t).digest("hex"); }

export async function createProxyKey(workspaceId: string, input: { mandateId: string; providerKeyId: string; name: string }, by: string) {
  const m = await getMandate(workspaceId, input.mandateId);
  if (!m) throw new Error("No such mandate in this workspace.");
  if (m.currency !== "USD") throw new Error("The API proxy prices calls in USD; issue a USD mandate for it.");
  const [pk] = await db.select().from(schema.providerKeys).where(and(eq(schema.providerKeys.id, input.providerKeyId), eq(schema.providerKeys.workspaceId, workspaceId))).limit(1);
  if (!pk) throw new Error("No such provider key in this workspace.");
  const token = newProxyToken();
  const row = { id: randomUUID(), workspaceId, mandateId: m.id, providerKeyId: pk.id, name: input.name.trim().slice(0, 60) || `${pk.provider} key`, status: "active", tokenHash: hash(token), tokenPrefix: token.slice(0, 10), tokenReveal: token, lastUsedAt: null, createdAt: new Date(), revokedAt: null };
  await db.transaction(async (tx) => {
    await tx.insert(schema.proxyKeys).values(row);
    await appendEvent(tx, workspaceId, "proxy.key_issued", { proxyKeyId: row.id, mandateId: m.id, provider: pk.provider, name: row.name, tokenPrefix: row.tokenPrefix, by });
  });
  return { ...row, token };
}

export async function revealProxyKey(workspaceId: string, id: string): Promise<string | null> {
  const [r] = await db.select({ t: schema.proxyKeys.tokenReveal }).from(schema.proxyKeys).where(and(eq(schema.proxyKeys.id, id), eq(schema.proxyKeys.workspaceId, workspaceId))).limit(1);
  return r?.t ?? null;
}

export async function revokeProxyKey(workspaceId: string, id: string, by: string) {
  await db.transaction(async (tx) => {
    const r = await tx.update(schema.proxyKeys).set({ status: "revoked", revokedAt: new Date(), tokenReveal: null }).where(and(eq(schema.proxyKeys.id, id), eq(schema.proxyKeys.workspaceId, workspaceId), eq(schema.proxyKeys.status, "active"))).returning({ id: schema.proxyKeys.id });
    if (r.length) await appendEvent(tx, workspaceId, "proxy.key_revoked", { proxyKeyId: id, by });
  });
}

export async function listProxyKeys(workspaceId: string) {
  return db.select({ k: schema.proxyKeys, mandateName: schema.mandates.name, provider: schema.providerKeys.provider, hint: schema.providerKeys.hint })
    .from(schema.proxyKeys).innerJoin(schema.mandates, eq(schema.mandates.id, schema.proxyKeys.mandateId)).innerJoin(schema.providerKeys, eq(schema.providerKeys.id, schema.proxyKeys.providerKeyId))
    .where(eq(schema.proxyKeys.workspaceId, workspaceId)).orderBy(desc(schema.proxyKeys.createdAt));
}

export async function recentCalls(workspaceId: string, limit = 30) {
  return db.select({ c: schema.proxyCalls, keyName: schema.proxyKeys.name, mandateName: schema.mandates.name })
    .from(schema.proxyCalls).innerJoin(schema.proxyKeys, eq(schema.proxyKeys.id, schema.proxyCalls.proxyKeyId)).innerJoin(schema.mandates, eq(schema.mandates.id, schema.proxyCalls.mandateId))
    .where(eq(schema.proxyCalls.workspaceId, workspaceId)).orderBy(desc(schema.proxyCalls.createdAt)).limit(limit);
}

// ---------- Resolving a request ----------

export type Resolved = { proxyKey: typeof schema.proxyKeys.$inferSelect; mandate: Mandate; provider: Provider; realKey: string };

export async function resolveProxyToken(token: string): Promise<Resolved | null> {
  if (!token.startsWith("mpx_")) return null;
  const [row] = await db.select({ k: schema.proxyKeys, pk: schema.providerKeys, m: schema.mandates })
    .from(schema.proxyKeys).innerJoin(schema.providerKeys, eq(schema.providerKeys.id, schema.proxyKeys.providerKeyId)).innerJoin(schema.mandates, eq(schema.mandates.id, schema.proxyKeys.mandateId))
    .where(eq(schema.proxyKeys.tokenHash, hash(token))).limit(1);
  if (!row || row.k.status !== "active") return null;
  if (!isProvider(row.pk.provider)) return null;
  return { proxyKey: row.k, mandate: row.m, provider: row.pk.provider, realKey: decrypt(row.pk.ciphertext) };
}

// ---------- Estimating and settling ----------

export type Estimate = { model: string; inputTokens: number; outputTokens: number; cents: number; priceMatched: string; streaming: boolean };

export function estimateRequest(provider: Provider, path: string, body: unknown): Estimate {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  let model = typeof b.model === "string" ? b.model : "";
  if (provider === "gemini") { const m = path.match(/models\/([^:/]+)/); if (m) model = m[1]; }
  const text = JSON.stringify(b.messages ?? b.input ?? b.contents ?? b.prompt ?? b.system ?? "") + JSON.stringify(b.system ?? "") + JSON.stringify(b.tools ?? "");
  const inputTokens = estimateTokens(text);
  const gen = (b.generationConfig && typeof b.generationConfig === "object" ? b.generationConfig : {}) as Record<string, unknown>;
  const maxOut = [b.max_tokens, b.max_output_tokens, b.max_completion_tokens, gen.maxOutputTokens].find((v) => typeof v === "number") as number | undefined;
  const isEmbedding = /embed/i.test(path) || /embed/i.test(model);
  const outputTokens = isEmbedding ? 0 : Math.max(1, Math.min(maxOut ?? PROVIDERS[provider].defaultMaxOut, 200_000));
  const { price, matched } = priceFor(provider, model || "unknown");
  const streaming = b.stream === true || /stream/i.test(path);
  return { model: model || "unknown", inputTokens, outputTokens, cents: costCents(price, inputTokens, outputTokens), priceMatched: matched, streaming };
}

export type Usage = { inputTokens: number; outputTokens: number; cachedTokens: number };

// Pull token usage out of a provider response body (JSON or accumulated SSE text).
export function parseUsage(provider: Provider, text: string): Usage | null {
  const nums = (re: RegExp) => { let last: number | null = null; for (const m of text.matchAll(re)) last = Number(m[1]); return last; };
  if (provider === "openai") {
    const inp = nums(/"prompt_tokens"\s*:\s*(\d+)/g) ?? nums(/"input_tokens"\s*:\s*(\d+)/g);
    const out = nums(/"completion_tokens"\s*:\s*(\d+)/g) ?? nums(/"output_tokens"\s*:\s*(\d+)/g);
    const cached = nums(/"cached_tokens"\s*:\s*(\d+)/g) ?? 0;
    if (inp == null && out == null) return null;
    return { inputTokens: inp ?? 0, outputTokens: out ?? 0, cachedTokens: cached };
  }
  if (provider === "anthropic") {
    const inp = nums(/"input_tokens"\s*:\s*(\d+)/g);
    const out = nums(/"output_tokens"\s*:\s*(\d+)/g);
    const cached = nums(/"cache_read_input_tokens"\s*:\s*(\d+)/g) ?? 0;
    const cacheWrite = nums(/"cache_creation_input_tokens"\s*:\s*(\d+)/g) ?? 0;
    if (inp == null && out == null) return null;
    return { inputTokens: (inp ?? 0) + cached + cacheWrite, outputTokens: out ?? 0, cachedTokens: cached };
  }
  const inp = nums(/"promptTokenCount"\s*:\s*(\d+)/g);
  const out = nums(/"candidatesTokenCount"\s*:\s*(\d+)/g);
  const cached = nums(/"cachedContentTokenCount"\s*:\s*(\d+)/g) ?? 0;
  if (inp == null && out == null) return null;
  return { inputTokens: inp ?? 0, outputTokens: out ?? 0, cachedTokens: cached };
}

export async function preauthorize(r: Resolved, est: Estimate, path: string): Promise<{ auth: AuthResult; callId: string }> {
  const auth = await authorize(r.mandate, {
    amount: est.cents, merchant: PROVIDERS[r.provider].name, category: "llm_api",
    purpose: `${est.model} · ~${est.inputTokens} in / ≤${est.outputTokens} out (${est.priceMatched})`,
  }, "proxy", { actor: `proxy key ${r.proxyKey.name}` });
  const callId = randomUUID();
  await db.insert(schema.proxyCalls).values({
    id: callId, workspaceId: r.mandate.workspaceId, mandateId: r.mandate.id, proxyKeyId: r.proxyKey.id, provider: r.provider, model: est.model, path,
    transactionId: auth.transactionId, decision: auth.decision, estimatedAmount: est.cents, actualAmount: null, inputTokens: null, outputTokens: null, upstreamStatus: null, streamed: est.streaming ? 1 : 0, createdAt: new Date(), settledAt: null,
  });
  await db.update(schema.proxyKeys).set({ lastUsedAt: new Date() }).where(eq(schema.proxyKeys.id, r.proxyKey.id));
  return { auth, callId };
}

// Replace the estimate with what the provider actually billed. A failed
// upstream call settles to zero so the mandate isn't charged for nothing.
export async function settle(r: Resolved, callId: string, transactionId: string, upstreamStatus: number, usage: Usage | null, est: Estimate) {
  const { price } = priceFor(r.provider, est.model);
  const ok = upstreamStatus >= 200 && upstreamStatus < 300;
  const actual = !ok ? 0 : usage ? costCents(price, usage.inputTokens, usage.outputTokens, usage.cachedTokens) : est.cents;
  await db.transaction(async (tx) => {
    await tx.update(schema.transactions).set({ amount: actual, reason: !ok ? `Upstream ${upstreamStatus}; settled to zero.` : usage ? `Settled on reported usage (est. ${est.cents}¢).` : `Settled at estimate (no usage reported).` }).where(eq(schema.transactions.id, transactionId));
    await tx.update(schema.proxyCalls).set({ actualAmount: actual, inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null, upstreamStatus, settledAt: new Date() }).where(eq(schema.proxyCalls.id, callId));
    await appendEvent(tx, r.mandate.workspaceId, ok ? "authorization.settled" : "authorization.voided", {
      transactionId, callId, mandateId: r.mandate.id, provider: r.provider, model: est.model, estimatedAmount: est.cents, actualAmount: actual,
      inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null, upstreamStatus,
    });
  });
}

export async function recordDeclined(r: Resolved, callId: string, upstreamStatus: number) {
  await db.update(schema.proxyCalls).set({ upstreamStatus, settledAt: new Date(), actualAmount: 0 }).where(eq(schema.proxyCalls.id, callId));
}
