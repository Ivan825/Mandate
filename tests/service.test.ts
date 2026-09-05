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
  const tampered = { ...receipt.signature!, message: receipt.signature!.message + "x" };
  assert.equal(verifySignature(tampered), false);
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
