import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "./db";
import { appendEvent } from "./ledger";
import { encrypt, decrypt } from "./crypto";
import { authorize, getMandate, type AuthResult } from "./service";
import { costCents, estimateTokens, priceFor, type Provider } from "./pricing";
import { sendWarning } from "./notify";
import { sweepReveals } from "./reveal";
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

// Only the endpoints we can price are forwarded. "generate" calls are
// pre-authorised and settled; "free" calls (model listings) cost nothing and
// are forwarded as-is; everything else is refused, so a proxy key can never
// reach billing, fine-tuning, file or admin endpoints with the real key.
export type RouteKind = "generate" | "free";
export function classifyRoute(provider: Provider, method: string, path: string): RouteKind | null {
  if (path.split("/").some((seg) => seg === "" || seg === "." || seg === ".." || seg.includes("\\"))) return null;
  if (method !== "POST" && method !== "GET") return null;
  if (provider === "openai") {
    if (method === "POST" && /^(chat\/completions|responses|embeddings|completions)$/.test(path)) return "generate";
    if (method === "GET" && /^models(\/[A-Za-z0-9._:-]+)?$/.test(path)) return "free";
    return null;
  }
  if (provider === "anthropic") {
    if (method === "POST" && path === "messages") return "generate";
    if (method === "POST" && path === "messages/count_tokens") return "free"; // costs nothing at the provider
    if (method === "GET" && /^models(\/[A-Za-z0-9._:-]+)?$/.test(path)) return "free";
    return null;
  }
  if (method === "POST" && /^models\/[A-Za-z0-9._-]+:(generateContent|streamGenerateContent|embedContent|batchEmbedContents)$/.test(path)) return "generate";
  if (method === "POST" && /^models\/[A-Za-z0-9._-]+:countTokens$/.test(path)) return "free";
  if (method === "GET" && /^models(\/[A-Za-z0-9._-]+)?$/.test(path)) return "free";
  return null;
}

// Request headers that may travel to the provider. Anything else (cookies,
// forwarded-for, custom headers, another org's id) stops here.
export const FORWARD_REQUEST_HEADERS = new Set(["content-type", "accept", "user-agent", "anthropic-version", "anthropic-beta", "openai-beta", "x-stainless-lang", "x-stainless-package-version", "x-stainless-os", "x-stainless-arch", "x-stainless-runtime", "x-stainless-runtime-version", "x-stainless-retry-count", "x-goog-api-client"]);
// Response headers passed back to the agent.
export const FORWARD_RESPONSE_HEADERS = ["content-type", "cache-control", "request-id", "x-request-id", "retry-after", "openai-processing-ms", "openai-version", "anthropic-ratelimit-requests-remaining", "anthropic-ratelimit-tokens-remaining", "x-ratelimit-limit-requests", "x-ratelimit-remaining-requests", "x-ratelimit-limit-tokens", "x-ratelimit-remaining-tokens", "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"];

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
  await sweepReveals().catch(() => {});
  return { ...row, token };
}

export async function revealProxyKey(workspaceId: string, id: string): Promise<string | null> {
  await sweepReveals().catch(() => {});
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

export type Estimate = { model: string; inputTokens: number; outputTokens: number; cents: number; priceMatched: string; streaming: boolean; unpriceable?: string };

// Tokens charged per attached image / audio / file part, since their bytes
// (or a URL) say nothing about what the provider will bill.
const MEDIA_TOKENS = 1_600;
// A Responses call that continues a stored conversation carries history we
// cannot see; budget for it rather than under-authorise.
const HIDDEN_HISTORY_TOKENS = 32_000;

function countMedia(v: unknown, depth = 0): number {
  if (depth > 6 || !v || typeof v !== "object") return 0;
  if (Array.isArray(v)) return v.reduce((n, x) => n + countMedia(x, depth + 1), 0);
  const o = v as Record<string, unknown>;
  let n = 0;
  const t = typeof o.type === "string" ? o.type : "";
  if (/^(image|image_url|input_image|input_audio|input_file|file|document|audio|video)$/.test(t)) n += 1;
  if (o.inline_data || o.inlineData || o.file_data || o.fileData) n += 1;
  for (const k of Object.keys(o)) if (k !== "type") n += countMedia(o[k], depth + 1);
  return n;
}

export function estimateRequest(provider: Provider, path: string, body: unknown): Estimate {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  let model = typeof b.model === "string" ? b.model : "";
  if (provider === "gemini") { const m = path.match(/models\/([^:/]+)/); if (m) model = m[1]; }
  const text = JSON.stringify(b.messages ?? b.input ?? b.contents ?? b.prompt ?? b.system ?? "") + JSON.stringify(b.system ?? "") + JSON.stringify(b.systemInstruction ?? b.system_instruction ?? "") + JSON.stringify(b.tools ?? "") + JSON.stringify(b.instructions ?? "");
  let inputTokens = estimateTokens(text) + countMedia(b.messages ?? b.input ?? b.contents ?? null) * MEDIA_TOKENS;
  if (typeof b.previous_response_id === "string" || typeof b.conversation === "string" || (b.conversation && typeof b.conversation === "object")) inputTokens += HIDDEN_HISTORY_TOKENS;
  const gen = ((b.generationConfig ?? b.generation_config) && typeof (b.generationConfig ?? b.generation_config) === "object" ? (b.generationConfig ?? b.generation_config) : {}) as Record<string, unknown>;
  const maxOut = [b.max_tokens, b.max_output_tokens, b.max_completion_tokens, gen.maxOutputTokens, gen.max_output_tokens].find((v) => typeof v === "number") as number | undefined;
  const isEmbedding = /embed/i.test(path) || /embed/i.test(model);
  const outputTokens = isEmbedding ? 0 : Math.max(1, Math.min(maxOut ?? PROVIDERS[provider].defaultMaxOut, 200_000));
  const { price, matched } = priceFor(provider, model || "unknown");
  const streaming = b.stream === true || /stream/i.test(path);
  const n = typeof b.n === "number" && b.n > 1 ? Math.min(b.n, 16) : 1;
  const cents = Math.max(1, costCents(price, inputTokens, outputTokens * n));
  return { model: model || "unknown", inputTokens, outputTokens: outputTokens * n, cents, priceMatched: matched, streaming };
}

export type Usage = { inputTokens: number; outputTokens: number; cachedTokens: number };

// Pull token usage out of a provider response body (JSON or accumulated SSE text).
export function parseUsage(provider: Provider, text: string): Usage | null {
  const nums = (re: RegExp) => { let last: number | null = null; for (const m of text.matchAll(re)) last = Number(m[1]); return last; };
  if (provider === "openai") {
    // completion_tokens / output_tokens already include reasoning tokens.
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
  const thoughts = nums(/"thoughtsTokenCount"\s*:\s*(\d+)/g) ?? 0; // billed as output, reported separately
  const cached = nums(/"cachedContentTokenCount"\s*:\s*(\d+)/g) ?? 0;
  if (inp == null && out == null) return null;
  return { inputTokens: inp ?? 0, outputTokens: (out ?? 0) + thoughts, cachedTokens: cached };
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
// The ledger always records the true cost; if that cost breaches the
// mandate's per-transaction limit or runs far past the estimate, the proxy
// key is suspended and the approvers told, so a mis-estimate cannot repeat.
const OVERRUN_FACTOR = 2;
export async function settle(r: Resolved, callId: string, transactionId: string, upstreamStatus: number, usage: Usage | null, est: Estimate) {
  const { price } = priceFor(r.provider, est.model);
  const ok = upstreamStatus >= 200 && upstreamStatus < 300;
  const actual = !ok ? 0 : usage ? costCents(price, usage.inputTokens, usage.outputTokens, usage.cachedTokens) : est.cents;
  const overrun = ok && (actual > r.mandate.perTxnLimit || (actual > est.cents * OVERRUN_FACTOR && actual - est.cents >= 50));
  await db.transaction(async (tx) => {
    await tx.update(schema.transactions).set({ amount: actual, reason: !ok ? `Upstream ${upstreamStatus}; settled to zero.` : usage ? `Settled on reported usage (est. ${est.cents}¢).` : `Settled at estimate (no usage reported).` }).where(eq(schema.transactions.id, transactionId));
    await tx.update(schema.proxyCalls).set({ actualAmount: actual, inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null, upstreamStatus, settledAt: new Date() }).where(eq(schema.proxyCalls.id, callId));
    await appendEvent(tx, r.mandate.workspaceId, ok ? "authorization.settled" : "authorization.voided", {
      transactionId, callId, mandateId: r.mandate.id, provider: r.provider, model: est.model, estimatedAmount: est.cents, actualAmount: actual,
      inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null, upstreamStatus,
    });
    if (overrun) {
      await tx.update(schema.proxyKeys).set({ status: "revoked", revokedAt: new Date(), tokenReveal: null }).where(and(eq(schema.proxyKeys.id, r.proxyKey.id), eq(schema.proxyKeys.status, "active")));
      await appendEvent(tx, r.mandate.workspaceId, "proxy.key_suspended", { proxyKeyId: r.proxyKey.id, name: r.proxyKey.name, mandateId: r.mandate.id, transactionId, estimatedAmount: est.cents, actualAmount: actual, perTxnLimit: r.mandate.perTxnLimit, reason: actual > r.mandate.perTxnLimit ? "settled above per-transaction limit" : "settled far above estimate" });
    }
  });
  if (overrun) {
    try {
      await sendWarning(r.mandate.workspaceId, `Proxy key "${r.proxyKey.name}" suspended after a ${(actual / 100).toFixed(2)} USD call`, `${r.mandate.name}: a ${est.model} call was estimated at ${(est.cents / 100).toFixed(2)} USD and settled at ${(actual / 100).toFixed(2)} USD (per-transaction limit ${(r.mandate.perTxnLimit / 100).toFixed(2)} USD). The key was revoked; issue a new one once the agent's requests are bounded.`, { kind: "proxy_overrun", mandateId: r.mandate.id, proxyKeyId: r.proxyKey.id, estimatedAmount: est.cents, actualAmount: actual });
    } catch (e) { console.error("overrun warning failed:", (e as Error).message); }
  }
}

export async function recordDeclined(r: Resolved, callId: string, upstreamStatus: number) {
  await db.update(schema.proxyCalls).set({ upstreamStatus, settledAt: new Date(), actualAmount: 0 }).where(eq(schema.proxyCalls.id, callId));
}
