// Integration tests against a real Postgres (DATABASE_URL). They create their
// own workspace and never touch anyone else's rows.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, schema } from "../lib/db";
import { createAgent, createMandate, authorize, decideApproval, listApprovals, getMandateByToken, revokeMandate, exposureBook } from "../lib/service";
import { verifyChain, allEvents } from "../lib/ledger";
import { buildReceipt, verifySignature } from "../lib/receipts";
import { rateLimit } from "../lib/ratelimit";
import { encrypt, decrypt } from "../lib/crypto";
import { estimateRequest, parseUsage } from "../lib/proxy";

let ws = "";
let agentId = "";

before(async () => {
  ws = "test-ws-" + randomUUID();
  const uid = "test-user-" + randomUUID();
  await db.insert(schema.user).values({ id: uid, name: "Test", email: `${uid}@example.com`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  await db.insert(schema.organization).values({ id: ws, name: "Test WS", slug: ws, createdAt: new Date() });
  await db.insert(schema.member).values({ id: randomUUID(), organizationId: ws, userId: uid, role: "owner", createdAt: new Date() });
  agentId = (await createAgent(ws, { name: "Test agent" })).id;
});

async function mandate(over: Partial<Parameters<typeof createMandate>[1]> = {}) {
  const r = await createMandate(ws, { agentId, name: "M", currency: "USD", perTxnLimit: 5000, dailyLimit: 10000, totalLimit: 50000, approvalAbove: 2000, allowedMerchants: ["OpenAI"], blockedCategories: [], activeHoursStart: 0, activeHoursEnd: 24, timezone: "UTC", expiresAt: null, ...over });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r;
}

test("token lookup is by hash and revocation kills it", async () => {
  const r = await mandate();
  const found = await getMandateByToken(r.token);
  assert.equal(found?.id, r.mandate.id);
  assert.equal(found?.tokenReveal, r.token); // plaintext held only until the reveal window sweeps it
  await revokeMandate(ws, r.mandate.id, "test");
  const after = await getMandateByToken(r.token);
  assert.equal(after?.status, "revoked");
  const d = await authorize(after!, { amount: 100, merchant: "OpenAI" }, "agent_api");
  assert.equal(d.rule, "status");
});

test("concurrent requests never exceed the daily limit", async () => {
  const r = await mandate({ perTxnLimit: 1000, dailyLimit: 3000, approvalAbove: null });
  const results = await Promise.all(Array.from({ length: 10 }, () => authorize(r.mandate, { amount: 800, merchant: "OpenAI" }, "agent_api")));
  const approved = results.filter((x) => x.decision === "approved").length;
  assert.equal(approved, 3); // 3 × 800 = 2400 ≤ 3000; a fourth would be 3200
});

test("escalation: pending → approve → allowance consumed once", async () => {
  const r = await mandate();
  const p = await authorize(r.mandate, { amount: 4500, merchant: "OpenAI" }, "agent_api");
  assert.equal(p.decision, "pending");
  const again = await authorize(r.mandate, { amount: 4500, merchant: "OpenAI" }, "agent_api");
  assert.equal(again.approvalId, p.approvalId); // deduplicated
  await decideApproval(ws, p.approvalId!, "approved", "test");
  const retries = await Promise.all([1, 2, 3].map(() => authorize(r.mandate, { amount: 4500, merchant: "OpenAI" }, "agent_api")));
  assert.equal(retries.filter((x) => x.rule === "allowance").length, 1);
  const list = await listApprovals(ws);
  assert.equal(list.find((a) => a.a.id === p.approvalId)?.a.status, "used");
});

test("denial cooling-off blocks the same ask", async () => {
  const r = await mandate();
  const p = await authorize(r.mandate, { amount: 3000, merchant: "OpenAI" }, "agent_api");
  await decideApproval(ws, p.approvalId!, "denied", "test");
  const again = await authorize(r.mandate, { amount: 3000, merchant: "OpenAI" }, "agent_api");
  assert.equal(again.rule, "denied_recently");
});

test("ledger chain verifies, incrementally and from genesis, and the receipt is signed", async () => {
  const inc = await verifyChain(ws);
  assert.equal(inc.ok, true);
  const full = await verifyChain(ws, true);
  assert.equal(full.ok, true);
  assert.equal(full.checked, (await allEvents(ws)).length);
  const receipt = await buildReceipt(ws, null);
  assert.ok(receipt.signature);
  assert.equal(verifySignature(receipt.signature!), true);
  // The verifier rebuilds the message from the head, so tampering with the
  // head, the workspace, or bringing your own key must all fail.
  assert.equal(verifySignature({ ...receipt.signature!, head: { ...receipt.signature!.head, hash: "0".repeat(64) } }), false);
  assert.equal(verifySignature({ ...receipt.signature!, workspaceId: "someone-else" }), false);
  assert.equal(verifySignature({ ...receipt.signature!, publicKeyPem: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n-----END PUBLIC KEY-----" }), true);
  assert.equal(verifySignature(receipt.signature!, "another-workspace"), false);
});

test("exposure book sums approved spend", async () => {
  const book = await exposureBook(ws);
  assert.ok(book.length >= 4);
  const withSpend = book.find((b) => b.spentTotal > 0);
  assert.ok(withSpend);
});

test("rate limiter counts per window", async () => {
  const key = "test:" + randomUUID();
  const a = await rateLimit(key, 2, 60); const b = await rateLimit(key, 2, 60); const c = await rateLimit(key, 2, 60);
  assert.deepEqual([a.ok, b.ok, c.ok], [true, true, false]);
});

test("provider keys round-trip through encryption", () => {
  const ct = encrypt("sk-secret-1234567890");
  assert.notEqual(ct, "sk-secret-1234567890");
  assert.equal(decrypt(ct), "sk-secret-1234567890");
});

test("proxy estimates are conservative and usage parses for all providers", () => {
  const est = estimateRequest("openai", "chat/completions", { model: "gpt-4o-mini", max_tokens: 100, messages: [{ role: "user", content: "hello world" }] });
  assert.equal(est.model, "gpt-4o-mini"); assert.ok(est.cents >= 1);
  assert.deepEqual(parseUsage("openai", '{"usage":{"prompt_tokens":10,"completion_tokens":5}}'), { inputTokens: 10, outputTokens: 5, cachedTokens: 0 });
  assert.deepEqual(parseUsage("anthropic", '{"usage":{"input_tokens":10,"output_tokens":5}}'), { inputTokens: 10, outputTokens: 5, cachedTokens: 0 });
  assert.deepEqual(parseUsage("gemini", '{"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5}}'), { inputTokens: 10, outputTokens: 5, cachedTokens: 0 });
  assert.equal(parseUsage("openai", "no usage here"), null);
});

test("idempotency: a key is reserved once, replays terminal answers, and releases pending", async () => {
  const { reserveIdempotent, completeIdempotent, releaseIdempotent } = await import("../lib/service");
  const r = await mandate();
  const m = r.mandate;
  // Twenty concurrent reservations of one key: exactly one wins.
  const outcomes = await Promise.all(Array.from({ length: 20 }, () => reserveIdempotent(m.id, "k1")));
  assert.equal(outcomes.filter((o) => o.kind === "reserved").length, 1);
  assert.equal(outcomes.filter((o) => o.kind === "in_progress").length, 19);
  // Pending is released, so the next attempt re-evaluates.
  await releaseIdempotent(m.id, "k1");
  assert.equal((await reserveIdempotent(m.id, "k1")).kind, "reserved");
  await completeIdempotent(m.id, "k1", 403, { decision: "declined" });
  const replay = await reserveIdempotent(m.id, "k1");
  assert.equal(replay.kind, "replay");
  if (replay.kind === "replay") { assert.equal(replay.status, 403); assert.equal(JSON.parse(replay.response).decision, "declined"); }
  // A completed key is not released by mistake.
  await releaseIdempotent(m.id, "k1");
  assert.equal((await reserveIdempotent(m.id, "k1")).kind, "replay");
});

test("mcp grants bind a client to the consented workspace and vanish on disconnect", async () => {
  const { bindClientWorkspace, grantedWorkspace, revokeConnectedAgent, isTokenRevoked } = await import("../lib/connections");
  const [u] = await db.select({ id: schema.user.id }).from(schema.user).limit(1);
  const clientId = "client-" + randomUUID();
  await db.insert(schema.oauthClient).values({ id: randomUUID(), clientId, name: "T", redirectUris: ["http://127.0.0.1/cb"] } as typeof schema.oauthClient.$inferInsert);
  await db.insert(schema.oauthConsent).values({ id: randomUUID(), clientId, userId: u.id, scopes: ["mandate:read"], createdAt: new Date(), updatedAt: new Date() });
  await bindClientWorkspace(u.id, clientId, ws);
  assert.equal((await grantedWorkspace(u.id, clientId))?.workspaceId, ws);
  assert.equal(await isTokenRevoked(null, u.id, clientId), false);
  await bindClientWorkspace(u.id, clientId, ws); // re-consent is an upsert
  await revokeConnectedAgent(u.id, clientId, ws);
  assert.equal(await grantedWorkspace(u.id, clientId), null);
  assert.equal(await isTokenRevoked(null, u.id, clientId), true);
});

test("card reconciliation accumulates partial captures and releases uncaptured holds", async () => {
  const { reconcileCard } = await import("../lib/service");
  const { creditTopup } = await import("../lib/balance");
  const r = await mandate({ approvalAbove: null });
  await creditTopup(r.mandate.workspaceId, "USD", 5000, "credit", "beta-credit-" + randomUUID(), "operator");
  const auth = await authorize(r.mandate, { amount: 1000, merchant: "OpenAI" }, "stripe", { stripeAuthorizationId: "iauth_" + randomUUID() });
  assert.equal(auth.decision, "approved");
  const [t0] = await db.select().from(schema.transactions).where((await import("drizzle-orm")).eq(schema.transactions.id, auth.transactionId));
  const authId = t0.stripeAuthorizationId!;
  await reconcileCard(authId, "capture", 300, "evt1");
  await reconcileCard(authId, "capture", 200, "evt2");
  await reconcileCard(authId, "closed", 0, "evt3");
  const [t1] = await db.select().from(schema.transactions).where((await import("drizzle-orm")).eq(schema.transactions.id, auth.transactionId));
  assert.equal(t1.amount, 500);
  const auth2 = await authorize(r.mandate, { amount: 700, merchant: "OpenAI" }, "stripe", { stripeAuthorizationId: "iauth_" + randomUUID() });
  const [t2] = await db.select().from(schema.transactions).where((await import("drizzle-orm")).eq(schema.transactions.id, auth2.transactionId));
  await reconcileCard(t2.stripeAuthorizationId!, "closed", 0, "evt4");
  const [t3] = await db.select().from(schema.transactions).where((await import("drizzle-orm")).eq(schema.transactions.id, auth2.transactionId));
  assert.equal(t3.amount, 0);
});

test("cards spend a prepaid balance: holds, captures, reversals and refunds net out", async () => {
  const { creditTopup, availableBalance } = await import("../lib/balance");
  const { reconcileCard } = await import("../lib/service");
  const { eq } = await import("drizzle-orm");
  // A fresh workspace so the balance starts at zero.
  const ws2 = "test-ws-" + randomUUID();
  const [u] = await db.select({ id: schema.user.id }).from(schema.user).limit(1);
  await db.insert(schema.organization).values({ id: ws2, name: "Balance WS", slug: ws2, createdAt: new Date() });
  await db.insert(schema.member).values({ id: randomUUID(), organizationId: ws2, userId: u.id, role: "owner", createdAt: new Date() });
  const ag = await createAgent(ws2, { name: "Card agent" });
  const r = await createMandate(ws2, { agentId: ag.id, name: "Card", currency: "USD", perTxnLimit: 5000, dailyLimit: 10000, totalLimit: 50000, approvalAbove: null, allowedMerchants: [], blockedCategories: [], activeHoursStart: 0, activeHoursEnd: 24, timezone: "UTC", expiresAt: null });
  if (!r.ok) throw new Error("terms");
  assert.equal(await availableBalance(ws2, "USD"), 0);
  // No money, no card spend — even though the mandate allows it.
  const dry = await authorize(r.mandate, { amount: 100, merchant: "OpenAI" }, "stripe", { stripeAuthorizationId: "iauth_" + randomUUID() });
  assert.equal(dry.decision, "declined"); assert.equal(dry.rule, "balance");
  // The same request over the API rail is not balance-gated.
  assert.equal((await authorize(r.mandate, { amount: 100, merchant: "OpenAI" }, "agent_api")).decision, "approved");
  const ref = "cs_test_" + randomUUID();
  assert.deepEqual(await creditTopup(ws2, "USD", 2000, "checkout", ref, "tester"), { credited: true });
  assert.deepEqual(await creditTopup(ws2, "USD", 2000, "checkout", ref, "tester"), { credited: false }); // webhook replay
  assert.equal(await availableBalance(ws2, "USD"), 2000);
  const a = await authorize(r.mandate, { amount: 1500, merchant: "OpenAI" }, "stripe", { stripeAuthorizationId: "iauth_" + randomUUID() });
  assert.equal(a.decision, "approved");
  assert.equal(await availableBalance(ws2, "USD"), 500); // hold
  const b = await authorize(r.mandate, { amount: 600, merchant: "OpenAI" }, "stripe", { stripeAuthorizationId: "iauth_" + randomUUID() });
  assert.equal(b.rule, "balance");
  const [ta] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, a.transactionId));
  await reconcileCard(ta.stripeAuthorizationId!, "capture", 1200, "evt-" + randomUUID());
  assert.equal(await availableBalance(ws2, "USD"), 800); // partial capture released 300
  await reconcileCard(ta.stripeAuthorizationId!, "refund", 200, "evt-" + randomUUID());
  assert.equal(await availableBalance(ws2, "USD"), 1000);
  // Concurrent card authorisations on one balance never overspend it.
  const results = await Promise.all(Array.from({ length: 6 }, () => authorize(r.mandate, { amount: 400, merchant: "OpenAI" }, "stripe", { stripeAuthorizationId: "iauth_" + randomUUID() })));
  assert.equal(results.filter((x) => x.decision === "approved").length, 2);
  assert.equal(await availableBalance(ws2, "USD"), 200);
});
