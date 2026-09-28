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

test("holds: approve → capture less releases the difference; void releases all; capture twice is refused", async () => {
  const { captureTransaction, voidTransaction, factsFor } = await import("../lib/service");
  const r = await mandate({ approvalAbove: null, perTxnLimit: 2000, dailyLimit: 5000 });
  const a = await authorize(r.mandate, { amount: 1200, merchant: "OpenAI" }, "agent_api");
  assert.equal(a.decision, "approved"); assert.equal(a.settlement, "held"); assert.ok(a.holdExpiresAt);
  assert.equal((await factsFor(r.mandate)).spentToday, 1200); // a hold counts while open
  const cap = await captureTransaction({ mandateId: r.mandate.id }, a.transactionId, { amount: 940, by: "agent" });
  assert.ok(cap.ok); if (cap.ok) { assert.equal(cap.released, 260); assert.equal(cap.transaction.settlement, "captured"); }
  assert.equal((await factsFor(r.mandate)).spentToday, 940);
  const again = await captureTransaction({ mandateId: r.mandate.id }, a.transactionId, { by: "agent" });
  assert.equal(again.ok, false); if (!again.ok) assert.equal(again.code, "not_held");
  const over = await authorize(r.mandate, { amount: 1500, merchant: "OpenAI" }, "agent_api");
  const bad = await captureTransaction({ mandateId: r.mandate.id }, over.transactionId, { amount: 1501, by: "agent" });
  assert.equal(bad.ok, false); if (!bad.ok) assert.equal(bad.code, "bad_amount");
  const v = await voidTransaction({ mandateId: r.mandate.id }, over.transactionId, { by: "agent", reason: "checkout failed" });
  assert.ok(v.ok); if (v.ok) assert.equal(v.released, 1500);
  assert.equal((await factsFor(r.mandate)).spentToday, 940);
  // Another mandate's token cannot touch this hold.
  const other = await mandate({ approvalAbove: null });
  const b = await authorize(r.mandate, { amount: 100, merchant: "OpenAI" }, "agent_api");
  assert.equal((await captureTransaction({ mandateId: other.mandate.id }, b.transactionId, { by: "agent" })).ok, false);
});

test("holds: expired holds close by the mandate's policy — capture in full or release", async () => {
  const { closeExpiredHolds, factsFor } = await import("../lib/service");
  const { eq } = await import("drizzle-orm");
  const cap = await mandate({ approvalAbove: null, holdTtlHours: 1, holdPolicy: "capture" });
  const rel = await mandate({ approvalAbove: null, holdTtlHours: 1, holdPolicy: "release" });
  const a = await authorize(cap.mandate, { amount: 700, merchant: "OpenAI" }, "agent_api");
  const b = await authorize(rel.mandate, { amount: 900, merchant: "OpenAI" }, "agent_api");
  const past = new Date(Date.now() - 2 * 3600_000);
  await db.update(schema.transactions).set({ holdExpiresAt: past }).where(eq(schema.transactions.id, a.transactionId));
  await db.update(schema.transactions).set({ holdExpiresAt: past }).where(eq(schema.transactions.id, b.transactionId));
  const n = await db.transaction((tx) => closeExpiredHolds(tx, new Date(), ws));
  assert.ok(n >= 2);
  const [ta] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, a.transactionId));
  const [tb] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, b.transactionId));
  assert.equal(ta.settlement, "captured"); assert.equal(ta.amount, 700);
  assert.equal(tb.settlement, "released"); assert.equal(tb.amount, 0);
  assert.equal((await factsFor(rel.mandate)).spentTotal, 0);
  // A zero-hour mandate settles at once.
  const now = await mandate({ approvalAbove: null, holdTtlHours: 0 });
  assert.equal((await authorize(now.mandate, { amount: 100, merchant: "OpenAI" }, "agent_api")).settlement, "captured");
});

test("event webhooks: queued with the ledger row, signed, delivered, retried and auto-disabled", async () => {
  const { createServer } = await import("node:http");
  const { addEndpoint, dispatchDue, verifySignature, filterMatches, normaliseFilter, listEndpoints, recentDeliveries } = await import("../lib/webhooks");
  const { eq } = await import("drizzle-orm");
  assert.equal(filterMatches(normaliseFilter("authorization., approval.approved"), "authorization.captured"), true);
  assert.equal(filterMatches(normaliseFilter("authorization."), "approval.approved"), false);
  assert.equal(filterMatches("*", "anything"), true);
  const got: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
  let mode: "ok" | "fail" = "ok";
  const srv = createServer((req, res) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => { got.push({ headers: req.headers as Record<string, string>, body: b }); res.statusCode = mode === "ok" ? 200 : 500; res.end(); }); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  // Loopback is refused unless the operator allows private targets.
  assert.equal((await addEndpoint(ws, { url: `http://127.0.0.1:${port}/hook` }, "tester")).ok, false);
  process.env.WEBHOOK_ALLOW_PRIVATE = "1";
  const added = await addEndpoint(ws, { url: `http://127.0.0.1:${port}/hook`, events: "authorization." }, "tester");
  if (!added.ok) { srv.close(); assert.fail(added.error); }
  const r = await mandate({ approvalAbove: null });
  const a = await authorize(r.mandate, { amount: 300, merchant: "OpenAI" }, "agent_api");
  const pending = await db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.endpointId, added.endpoint.id));
  assert.ok(pending.some((d) => d.eventType === "authorization.approved"), "delivery queued in the same transaction");
  assert.ok(!pending.some((d) => d.eventType === "mandate.issued"), "filter keeps other events out");
  await dispatchDue({ limit: 50 });
  const hit = got.find((g) => JSON.parse(g.body).data.transactionId === a.transactionId);
  assert.ok(hit, "delivered to the endpoint");
  const env = JSON.parse(hit!.body);
  assert.equal(env.type, "authorization.approved"); assert.ok(env.summary.includes("OpenAI")); assert.ok(env.seq > 0);
  assert.equal(verifySignature(added.secret, hit!.body, String(hit!.headers["mandate-signature"])), true);
  assert.equal(verifySignature("whsec_wrong", hit!.body, String(hit!.headers["mandate-signature"])), false);
  // Failures back off and eventually disable the endpoint.
  mode = "fail";
  const b = await authorize(r.mandate, { amount: 100, merchant: "OpenAI" }, "agent_api");
  await dispatchDue({ limit: 50 });
  const [d1] = await db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.endpointId, added.endpoint.id)).then((rows) => rows.filter((x) => x.body.includes(b.transactionId)));
  assert.equal(d1.status, "pending"); assert.equal(d1.attempts, 1); assert.ok(d1.nextAttemptAt.getTime() > Date.now() + 30_000, "backed off");
  await db.update(schema.webhookEndpoints).set({ consecutiveFailures: 24 }).where(eq(schema.webhookEndpoints.id, added.endpoint.id));
  await db.update(schema.webhookDeliveries).set({ nextAttemptAt: new Date(0) }).where(eq(schema.webhookDeliveries.id, d1.id));
  await dispatchDue({ limit: 50 });
  const [ep] = (await listEndpoints(ws)).filter((e) => e.id === added.endpoint.id);
  assert.equal(ep.enabled, 0); assert.ok(ep.disabledReason?.includes("consecutive"));
  assert.ok((await recentDeliveries(ws)).length >= 2);
  delete process.env.WEBHOOK_ALLOW_PRIVATE;
  srv.closeAllConnections(); srv.close();
});

test("activity feed: events read as sentences, filter by group and mandate, notes attach", async () => {
  const { listActivity, addNote, describeEvent } = await import("../lib/activity");
  const r = await mandate({ approvalAbove: 500, name: "Feed test" });
  const a = await authorize(r.mandate, { amount: 900, merchant: "OpenAI", purpose: "credits" }, "mcp", { actor: "Claude" });
  assert.equal(a.decision, "pending");
  const feed = await listActivity(ws, { mandateId: r.mandate.id, limit: 10 });
  assert.ok(feed.rows.length >= 2);
  const ask = feed.rows.find((x) => x.e.type === "authorization.pending");
  assert.ok(ask?.d.summary.includes("Test agent"), ask?.d.summary);
  assert.ok(ask?.d.summary.includes("waiting for approval"));
  const decisionsOnly = await listActivity(ws, { group: "decisions", mandateId: r.mandate.id });
  assert.ok(decisionsOnly.rows.every((x) => x.e.type.startsWith("authorization.")));
  const pendingOnly = await listActivity(ws, { outcome: "pending", mandateId: r.mandate.id });
  assert.ok(pendingOnly.rows.length >= 1 && pendingOnly.rows.every((x) => ["authorization.pending", "approval.requested"].includes(x.e.type)));
  const search = await listActivity(ws, { q: "Feed test" });
  assert.ok(search.rows.some((x) => x.e.type === "mandate.issued"));
  const note = await addNote(ws, { type: "transaction", id: a.transactionId }, "Checked with the vendor; fine.", { id: "u1", email: "owner@example.com" });
  assert.ok(note);
  const withNotes = await listActivity(ws, { mandateId: r.mandate.id });
  assert.ok(withNotes.rows.find((x) => x.e.type === "authorization.pending")?.notes.some((n) => n.body.includes("vendor")));
  assert.equal(describeEvent("mandate.revoked", { by: "me" }).tone, "bad");
});

test("pause freezes the token, auto-resumes on time; raises lift a limit and can be withdrawn", async () => {
  const { pauseMandate, resumeMandate, raiseLimit, withdrawRaise, getMandate } = await import("../lib/service");
  const { eq } = await import("drizzle-orm");
  const r = await mandate({ approvalAbove: null, perTxnLimit: 1000, dailyLimit: 3000 });
  assert.equal(await pauseMandate(ws, r.mandate.id, { until: null, by: "owner" }), true);
  const m1 = (await getMandate(ws, r.mandate.id))!;
  const d = await authorize(m1, { amount: 100, merchant: "OpenAI" }, "agent_api");
  assert.equal(d.rule, "paused"); assert.equal(d.remedy?.approvalRequired, true);
  assert.equal(await resumeMandate(ws, r.mandate.id, "owner"), true);
  assert.equal((await authorize((await getMandate(ws, r.mandate.id))!, { amount: 100, merchant: "OpenAI" }, "agent_api")).decision, "approved");
  // A timed pause that has already run out resumes itself on the next request.
  await pauseMandate(ws, r.mandate.id, { until: new Date(Date.now() - 1000), by: "owner" });
  const woke = await authorize((await getMandate(ws, r.mandate.id))!, { amount: 100, merchant: "OpenAI" }, "agent_api");
  assert.equal(woke.decision, "approved");
  assert.equal((await getMandate(ws, r.mandate.id))!.status, "active");
  // Raise: 1500 fails per-txn (1000) until raised.
  const m = (await getMandate(ws, r.mandate.id))!;
  assert.equal((await authorize(m, { amount: 1500, merchant: "OpenAI" }, "agent_api")).rule, "per_txn");
  assert.equal((await raiseLimit(ws, m.id, { field: "per_txn", amount: 500, endsAt: new Date(Date.now() + 3600_000), by: "owner" })).ok, false); // not above base
  const raised = await raiseLimit(ws, m.id, { field: "per_txn", amount: 2000, endsAt: new Date(Date.now() + 3600_000), by: "owner", reason: "launch" });
  assert.ok(raised.ok);
  assert.equal((await authorize(m, { amount: 1500, merchant: "OpenAI" }, "agent_api")).decision, "approved");
  if (raised.ok) assert.equal(await withdrawRaise(ws, m.id, raised.override.id, "owner"), true);
  assert.equal((await authorize(m, { amount: 1500, merchant: "OpenAI" }, "agent_api")).rule, "per_txn");
  const events = await db.select({ type: schema.ledger.type }).from(schema.ledger).where(eq(schema.ledger.workspaceId, ws));
  for (const t of ["mandate.paused", "mandate.resumed", "mandate.raised", "mandate.raise_withdrawn"]) assert.ok(events.some((e) => e.type === t), t);
});

test("anomaly flags: unusual amount, new merchant, decline burst, rapid repeat", async () => {
  const { computeFlags } = await import("../lib/anomaly");
  const { eq } = await import("drizzle-orm");
  const r = await mandate({ approvalAbove: null, perTxnLimit: 5000, dailyLimit: 100000, totalLimit: 500000, allowedMerchants: [] });
  for (let i = 0; i < 6; i++) await authorize(r.mandate, { amount: 200, merchant: "OpenAI" }, "agent_api");
  assert.deepEqual(await computeFlags(db, r.mandate.id, { amount: 200, merchant: "OpenAI" }), ["rapid_repeat"]);
  assert.deepEqual(await computeFlags(db, r.mandate.id, { amount: 900, merchant: "OpenAI" }), ["unusual_amount"]);
  assert.deepEqual(await computeFlags(db, r.mandate.id, { amount: 200, merchant: "Namecheap" }), ["new_merchant"]);
  const big = await authorize(r.mandate, { amount: 4000, merchant: "Vercel" }, "agent_api");
  assert.deepEqual(big.flags, ["unusual_amount", "new_merchant"]);
  const [row] = await db.select({ flags: schema.transactions.flags }).from(schema.transactions).where(eq(schema.transactions.id, big.transactionId));
  assert.equal(row.flags, '["unusual_amount","new_merchant"]');
  for (let i = 0; i < 3; i++) await authorize(r.mandate, { amount: 9000, merchant: "OpenAI" }, "agent_api"); // per_txn declines
  assert.ok((await computeFlags(db, r.mandate.id, { amount: 100, merchant: "OpenAI" })).includes("decline_burst"));
  // A request that escalates carries its flags on the approval row too.
  const ask = await mandate({ approvalAbove: 100, perTxnLimit: 5000, allowedMerchants: [] });
  for (let i = 0; i < 5; i++) await authorize(ask.mandate, { amount: 50, merchant: "OpenAI" }, "agent_api");
  const p = await authorize(ask.mandate, { amount: 3000, merchant: "Stripe" }, "agent_api");
  assert.equal(p.decision, "pending");
  const [ap] = await db.select({ flags: schema.approvals.flags }).from(schema.approvals).where(eq(schema.approvals.id, p.approvalId!));
  assert.equal(ap.flags, '["unusual_amount","new_merchant"]');
});

test("veto window: announced, pending with retryAt, matures into an allowance, cancel blocks it", async () => {
  const { expireStale, decideApproval } = await import("../lib/service");
  const { eq } = await import("drizzle-orm");
  const r = await mandate({ approvalAbove: 4000, vetoAbove: 1000, vetoMinutes: 1, allowedMerchants: [] });
  const v = await authorize(r.mandate, { amount: 1500, merchant: "OpenAI" }, "agent_api");
  assert.equal(v.decision, "pending"); assert.equal(v.rule, "veto"); assert.ok(v.remedy?.retryAt);
  const [row] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, v.approvalId!));
  assert.equal(row.kind, "veto"); assert.ok(row.vetoUntil);
  // Same ask before the window closes: still pending, same row.
  assert.equal((await authorize(r.mandate, { amount: 1500, merchant: "OpenAI" }, "agent_api")).approvalId, v.approvalId);
  // Time passes.
  await db.update(schema.approvals).set({ vetoUntil: new Date(Date.now() - 1000) }).where(eq(schema.approvals.id, v.approvalId!));
  await db.transaction((tx) => expireStale(tx, ws));
  const [matured] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, v.approvalId!));
  assert.equal(matured.status, "approved"); assert.equal(matured.decidedBy, "silence");
  const through = await authorize(r.mandate, { amount: 1500, merchant: "OpenAI" }, "agent_api");
  assert.equal(through.decision, "approved"); assert.equal(through.rule, "veto_passed");
  // A cancelled one is blocked for the cooling-off period.
  const v2 = await authorize(r.mandate, { amount: 1600, merchant: "OpenAI" }, "agent_api");
  await decideApproval(ws, v2.approvalId!, "denied", "owner");
  assert.equal((await authorize(r.mandate, { amount: 1600, merchant: "OpenAI" }, "agent_api")).rule, "denied_recently");
  // Asking wins above its own threshold.
  assert.equal((await authorize(r.mandate, { amount: 4500, merchant: "OpenAI" }, "agent_api")).rule, "approval");
});

test("plans: proposed → approved → items pass once without asking → completed; over-limit items refused", async () => {
  const { proposePlan, decidePlan, getPlan } = await import("../lib/service");
  const r = await mandate({ approvalAbove: 500, perTxnLimit: 5000, allowedMerchants: [] });
  const bad = await proposePlan(r.mandate, { title: "Too big", items: [{ merchant: "OpenAI", amount: 9000 }] });
  assert.equal(bad.ok, false);
  const p = await proposePlan(r.mandate, { title: "Q4 tools", items: [{ merchant: "OpenAI", amount: 3000, purpose: "credits" }, { merchant: "Vercel*", amount: 2000 }], proposedBy: "Claude", source: "mcp" });
  assert.ok(p.ok); if (!p.ok) return;
  assert.equal((await authorize(r.mandate, { amount: 2900, merchant: "OpenAI" }, "agent_api")).decision, "pending"); // not approved yet: normal rules
  assert.ok(await decidePlan(ws, p.plan.id, "approved", "owner"));
  const a = await authorize(r.mandate, { amount: 2900, merchant: "OpenAI" }, "agent_api");
  assert.equal(a.decision, "approved"); assert.equal(a.rule, "plan");
  assert.equal((await authorize(r.mandate, { amount: 2900, merchant: "OpenAI" }, "agent_api")).decision, "pending"); // item used up
  const plan = (await getPlan({ workspaceId: ws }, p.plan.id))!;
  assert.equal(plan.status, "approved"); assert.equal(JSON.parse(plan.items)[0].usedBy, a.transactionId);
  const b = await authorize(r.mandate, { amount: 1999, merchant: "Vercel Pro" }, "agent_api");
  assert.equal(b.rule, "plan");
  assert.equal((await getPlan({ workspaceId: ws }, p.plan.id))!.status, "completed");
});

test("shadow mode: nothing declined, verdicts recorded, report counts them", async () => {
  const { setMandateMode, shadowReport } = await import("../lib/service");
  const { eq } = await import("drizzle-orm");
  const r = await mandate({ approvalAbove: 2000, perTxnLimit: 5000, dailyLimit: 6000, allowedMerchants: ["OpenAI"] });
  await setMandateMode(ws, r.mandate.id, "observe", "owner");
  const m = (await db.select().from(schema.mandates).where(eq(schema.mandates.id, r.mandate.id)))[0];
  const a = await authorize(m, { amount: 100, merchant: "Namecheap" }, "agent_api");  // would decline: merchant
  const b = await authorize(m, { amount: 3000, merchant: "OpenAI" }, "agent_api");    // would ask
  const c = await authorize(m, { amount: 100, merchant: "OpenAI" }, "agent_api");     // fine either way
  assert.deepEqual([a.decision, b.decision, c.decision], ["approved", "approved", "approved"]);
  assert.equal(a.rule, "observe"); assert.equal(a.shadow?.rule, "merchant"); assert.equal(b.shadow?.decision, "pending"); assert.equal(c.shadow?.decision, "approved");
  const rep = await shadowReport(ws, r.mandate.id);
  assert.equal(rep.total, 3); assert.equal(rep.wouldDecline, 1); assert.equal(rep.wouldAsk, 1);
  assert.equal((await db.select().from(schema.approvals).where(eq(schema.approvals.mandateId, r.mandate.id))).length, 0, "no approval rows while observing");
  await setMandateMode(ws, r.mandate.id, "enforce", "owner");
  const m2 = (await db.select().from(schema.mandates).where(eq(schema.mandates.id, r.mandate.id)))[0];
  assert.equal((await authorize(m2, { amount: 100, merchant: "Namecheap" }, "agent_api")).decision, "declined");
});

test("graduated autonomy: clean decisions raise the limits step by step; a denial steps back", async () => {
  const { getMandate, decideApproval } = await import("../lib/service");
  const r = await mandate({ approvalAbove: 1000, perTxnLimit: 2000, dailyLimit: 100000, totalLimit: 500000, autonomyStep: 500, autonomyEvery: 3, autonomyCeiling: 3000, allowedMerchants: [] });
  for (let i = 0; i < 3; i++) await authorize(r.mandate, { amount: 100 + i, merchant: "OpenAI" }, "agent_api");
  let m = (await getMandate(ws, r.mandate.id))!;
  assert.equal(m.autonomyLevel, 500); assert.equal(m.autonomyStreak, 0);
  assert.equal((await authorize(m, { amount: 1400, merchant: "OpenAI" }, "agent_api")).decision, "approved"); // lifted threshold 1500
  assert.equal((await authorize(m, { amount: 2400, merchant: "OpenAI" }, "agent_api")).rule, "approval"); // per-txn lifted to 2500, but above the lifted threshold
  for (let i = 0; i < 6; i++) await authorize((await getMandate(ws, r.mandate.id))!, { amount: 200 + i, merchant: "OpenAI" }, "agent_api");
  m = (await getMandate(ws, r.mandate.id))!;
  assert.equal(m.autonomyLevel, 1000); // ceiling 3000 − 2000
  const p = await authorize(m, { amount: 2900, merchant: "OpenAI" }, "agent_api");
  assert.equal(p.decision, "pending");
  await decideApproval(ws, p.approvalId!, "denied", "owner");
  m = (await getMandate(ws, r.mandate.id))!;
  assert.equal(m.autonomyLevel, 500);
});

test("human-signed approval: a real ES256 passkey assertion verifies and is recorded; a wrong decision is refused", async () => {
  const { generateKeyPairSync, createSign, createHash } = await import("node:crypto");
  const { challengeFor, verifyHumanSignature, rpId } = await import("../lib/human-sign");
  const { base64 } = await import("@better-auth/utils/base64");
  const { appUrl } = await import("../lib/env");
  const { decideApproval, getApproval } = await import("../lib/service");
  const { eq } = await import("drizzle-orm");
  // Register a passkey for the test user: a P-256 key in COSE form, as the Better Auth plugin stores it.
  const [u] = await db.select({ id: schema.user.id }).from(schema.user).limit(1);
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const x = Buffer.from(jwk.x, "base64url"), y = Buffer.from(jwk.y, "base64url");
  const cose = Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), x, Buffer.from([0x22, 0x58, 0x20]), y]);
  const credentialID = "cred-" + randomUUID();
  await db.insert(schema.passkey).values({ id: randomUUID(), name: "test", publicKey: base64.encode(cose), userId: u.id, credentialID, counter: 0, deviceType: "singleDevice", backedUp: false, transports: "internal", createdAt: new Date() });
  const r = await mandate();
  const ask = await authorize(r.mandate, { amount: 4500, merchant: "OpenAI" }, "agent_api");
  const challenge = challengeFor(ask.approvalId!, "approve", u.id);
  const sign = (chal: string) => {
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: chal, origin: appUrl(), crossOrigin: false }));
    const authData = Buffer.concat([createHash("sha256").update(rpId()).digest(), Buffer.from([0x01]), Buffer.from([0, 0, 0, 1])]);
    const sig = createSign("sha256").update(Buffer.concat([authData, createHash("sha256").update(clientData).digest()])).sign(privateKey);
    return { id: credentialID, rawId: credentialID, type: "public-key" as const, clientExtensionResults: {}, response: { clientDataJSON: clientData.toString("base64url"), authenticatorData: authData.toString("base64url"), signature: sig.toString("base64url") } };
  };
  const wrong = await verifyHumanSignature(u.id, ask.approvalId!, "deny", sign(challenge));
  assert.equal(wrong.ok, false); // the challenge commits to "approve"
  const ok = await verifyHumanSignature(u.id, ask.approvalId!, "approve", sign(challenge));
  assert.ok(ok.ok, (ok as { error?: string }).error); if (!ok.ok) return;
  assert.equal(ok.signature.alg, -7);
  await decideApproval(ws, ask.approvalId!, "approved", "owner (passkey)", ok.signature);
  const row = (await getApproval(ask.approvalId!))!.a;
  assert.equal(row.signedWith, credentialID); assert.ok(row.signature);
  const [ev] = await db.select({ payload: schema.ledger.payload }).from(schema.ledger).where(eq(schema.ledger.type, "approval.approved")).then((rows) => rows.filter((e) => e.payload.includes(ask.approvalId!)));
  assert.ok(ev.payload.includes("humanSigned"));
  const { recheckHumanSignature } = await import("../lib/human-sign");
  assert.equal(await recheckHumanSignature(JSON.parse(row.signature!)), true);
  const tampered = { ...JSON.parse(row.signature!), signature: Buffer.from("nope").toString("base64url") };
  assert.equal(await recheckHumanSignature(tampered), false);
});

test("panic button: freezes every rail at once, records who and why, unfreeze restores", async () => {
  const { freezeWorkspace, unfreezeWorkspace, getWorkspaceSettings, getMandate } = await import("../lib/service");
  const r = await mandate({ approvalAbove: null });
  assert.equal((await authorize(r.mandate, { amount: 100, merchant: "OpenAI" }, "agent_api")).decision, "approved");
  await freezeWorkspace(ws, "owner@example.com", "agent is looping");
  const s = await getWorkspaceSettings(ws);
  assert.equal(s.frozen?.by, "owner@example.com"); assert.equal(s.frozen?.reason, "agent is looping");
  const d = await authorize((await getMandate(ws, r.mandate.id))!, { amount: 100, merchant: "OpenAI" }, "agent_api");
  assert.equal(d.decision, "declined"); assert.equal(d.rule, "frozen");
  const mcp = await authorize((await getMandate(ws, r.mandate.id))!, { amount: 100, merchant: "OpenAI" }, "mcp");
  assert.equal(mcp.rule, "frozen");
  await freezeWorkspace(ws, "someone else", "again"); // idempotent: the first press stands
  assert.equal((await getWorkspaceSettings(ws)).frozen?.by, "owner@example.com");
  await unfreezeWorkspace(ws, "owner@example.com");
  assert.equal((await getWorkspaceSettings(ws)).frozen, null);
  assert.equal((await authorize((await getMandate(ws, r.mandate.id))!, { amount: 100, merchant: "OpenAI" }, "agent_api")).decision, "approved");
  const { eq } = await import("drizzle-orm");
  const events = await db.select({ type: schema.ledger.type }).from(schema.ledger).where(eq(schema.ledger.workspaceId, ws));
  assert.ok(events.some((e) => e.type === "workspace.frozen")); assert.ok(events.some((e) => e.type === "workspace.unfrozen"));
});

test("co-signing: N distinct approvers, no double signing, one denial ends it, the last signature grants the allowance", async () => {
  const { decideApproval, getApproval } = await import("../lib/service");
  const r = await mandate({ approvalAbove: 2000, cosignAbove: 4000, cosignCount: 2 });
  const small = await authorize(r.mandate, { amount: 3000, merchant: "OpenAI" }, "agent_api");
  assert.equal(small.decision, "pending"); assert.equal((await getApproval(small.approvalId!))!.a.requiredApprovers, 1);
  const big = await authorize(r.mandate, { amount: 4500, merchant: "OpenAI" }, "agent_api");
  assert.equal(big.decision, "pending"); assert.match(big.reason, /2 approvers/);
  assert.equal((await getApproval(big.approvalId!))!.a.requiredApprovers, 2);
  const first = await decideApproval(ws, big.approvalId!, "approved", "alice@example.com") as { status: string; cosigned?: boolean; have?: number; need?: number } | null;
  assert.equal(first?.status, "pending"); assert.equal(first?.cosigned, true); assert.equal(first?.have, 1); assert.equal(first?.need, 2);
  assert.equal((await authorize(r.mandate, { amount: 4500, merchant: "OpenAI" }, "agent_api")).decision, "pending"); // one signature is not an allowance
  const again = await decideApproval(ws, big.approvalId!, "approved", "Alice@Example.com") as { alreadySigned?: boolean } | null;
  assert.equal(again?.alreadySigned, true);
  const second = await decideApproval(ws, big.approvalId!, "approved", "bob@example.com");
  assert.equal(second?.status, "approved");
  const done = await authorize(r.mandate, { amount: 4500, merchant: "OpenAI" }, "agent_api");
  assert.equal(done.rule, "allowance");
  assert.equal((await getApproval(big.approvalId!))!.a.decidedBy, "alice@example.com + bob@example.com");
  // A denial by anyone ends a half-signed request.
  const other = await authorize(r.mandate, { amount: 4800, merchant: "OpenAI" }, "agent_api");
  await decideApproval(ws, other.approvalId!, "approved", "alice@example.com");
  const denied = await decideApproval(ws, other.approvalId!, "denied", "bob@example.com");
  assert.equal(denied?.status, "denied");
  assert.equal((await authorize(r.mandate, { amount: 4800, merchant: "OpenAI" }, "agent_api")).rule, "denied_recently");
});

test("delegation: a sub-mandate fits inside its parent, spends the parent's money, and dies with it", async () => {
  const { delegateMandate, getMandate, getMandateByToken, revokeMandate, listChildren, familyIds } = await import("../lib/service");
  const r = await mandate({ approvalAbove: null, perTxnLimit: 2000, dailyLimit: 5000, totalLimit: 20000, allowedMerchants: ["OpenAI", "Vercel*"] });
  const bad = await delegateMandate(r.mandate, { name: "too big", perTxnLimit: 3000, dailyLimit: 5000, totalLimit: 20000, allowedMerchants: ["Namecheap"] });
  assert.equal(bad.ok, false);
  if (!bad.ok) { assert.ok(bad.errors.some((e) => e.field === "perTxnLimit")); assert.ok(bad.errors.some((e) => e.field === "allowedMerchants")); }
  const child = await delegateMandate(r.mandate, { name: "helper", perTxnLimit: 1000, dailyLimit: 3000, totalLimit: 3000, allowedMerchants: ["OpenAI"], agentName: "helper-1", by: "agent" });
  assert.ok(child.ok);
  if (!child.ok) return;
  assert.equal(child.mandate.parentId, r.mandate.id); assert.equal(child.mandate.depth, 1);
  assert.equal((await getMandateByToken(child.token))?.id, child.mandate.id);
  assert.deepEqual((await familyIds(r.mandate.id)).sort(), [r.mandate.id, child.mandate.id].sort());
  assert.equal((await listChildren(ws, r.mandate.id)).length, 1);
  // The child spends: its own limits and the parent's family limits both count.
  assert.equal((await authorize(child.mandate, { amount: 900, merchant: "OpenAI" }, "agent_api")).decision, "approved");
  assert.equal((await authorize(child.mandate, { amount: 900, merchant: "Vercel Pro" }, "agent_api")).rule, "merchant"); // child's own narrower list
  assert.equal((await authorize(r.mandate, { amount: 2000, merchant: "OpenAI" }, "agent_api")).decision, "approved");
  assert.equal((await authorize(r.mandate, { amount: 2000, merchant: "OpenAI" }, "agent_api")).decision, "approved"); // parent at 4900 of 5000 with the child's 900
  const parentBinds = await authorize(child.mandate, { amount: 500, merchant: "OpenAI" }, "agent_api");
  assert.equal(parentBinds.decision, "declined"); assert.equal(parentBinds.rule, "parent_daily"); assert.match(parentBinds.reason, /Parent mandate/);
  const facts = await factsForTest(r.mandate.id);
  assert.equal(facts.spentToday, 4900);
  // Depth and revocation.
  const grandchild = await delegateMandate((await getMandate(ws, child.mandate.id))!, { name: "gc", perTxnLimit: 100, dailyLimit: 100, totalLimit: 100, allowedMerchants: ["OpenAI"] });
  assert.ok(grandchild.ok);
  await revokeMandate(ws, r.mandate.id, "owner");
  assert.equal((await getMandate(ws, child.mandate.id))!.status, "revoked");
  if (grandchild.ok) assert.equal((await getMandate(ws, grandchild.mandate.id))!.status, "revoked");
});

async function factsForTest(mandateId: string) {
  const { factsFor, getMandate } = await import("../lib/service");
  return factsFor((await getMandate(ws, mandateId))!);
}

test("disputes: open marks the decision (and can pause), refunded nets the limits down, upheld leaves them", async () => {
  const { openDispute, resolveDispute, listDisputes, getTransaction, getMandate } = await import("../lib/service");
  const r = await mandate({ approvalAbove: null, holdTtlHours: 0 });
  const t = await authorize(r.mandate, { amount: 1200, merchant: "OpenAI" }, "agent_api");
  const declined = await authorize(r.mandate, { amount: 1200, merchant: "Namecheap" }, "agent_api");
  assert.equal((await openDispute(ws, declined.transactionId, { reason: "x", by: "owner" })).ok, false); // nothing was spent
  const d = await openDispute(ws, t.transactionId, { reason: "never delivered", by: "owner@example.com", pause: true });
  assert.ok(d.ok);
  assert.equal((await getTransaction({ workspaceId: ws }, t.transactionId))!.disputeId, d.ok ? d.dispute.id : "");
  assert.equal((await getMandate(ws, r.mandate.id))!.status, "paused");
  await (await import("../lib/service")).resumeMandate(ws, r.mandate.id, "owner");
  assert.equal((await openDispute(ws, t.transactionId, { reason: "again", by: "owner" })).ok, false); // already disputed
  assert.equal((await factsForTest(r.mandate.id)).spentTotal, 1200);
  if (d.ok) {
    const res = await resolveDispute(ws, d.dispute.id, "refunded", "owner@example.com", "merchant refunded");
    assert.ok(res.ok);
    assert.equal((await factsForTest(r.mandate.id)).spentTotal, 0); // negative row nets it out
    assert.equal((await resolveDispute(ws, d.dispute.id, "upheld", "x")).ok, false); // already resolved
  }
  assert.equal((await listDisputes(ws, { mandateId: r.mandate.id })).length, 1);
  const t2 = await authorize(r.mandate, { amount: 500, merchant: "OpenAI" }, "agent_api");
  const d2 = await openDispute(ws, t2.transactionId, { reason: "wrong item", by: "owner" });
  if (d2.ok) await resolveDispute(ws, d2.dispute.id, "upheld", "owner");
  assert.equal((await factsForTest(r.mandate.id)).spentTotal, 500);
});

test("vouchers: signed, verifiable offline, redeemable once by the merchant for at most the authorised amount", async () => {
  const { issueVoucher, verifyVoucher, voucherStatus, redeemVoucher } = await import("../lib/vouchers");
  const { getTransaction } = await import("../lib/service");
  const r = await mandate({ approvalAbove: null });
  const a = await authorize(r.mandate, { amount: 1500, merchant: "OpenAI" }, "agent_api");
  const t = (await getTransaction({ mandateId: r.mandate.id }, a.transactionId))!;
  const v = issueVoucher(t, r.mandate, "Test agent", "https://mandate.test")!;
  assert.ok(v.startsWith("mv1."));
  const c = verifyVoucher(v);
  assert.equal(c.valid, true); assert.equal(c.payload?.amount, 1500); assert.equal(c.payload?.tx, t.id);
  const [tag, p, s] = v.split(".");
  const tampered = `${tag}.${Buffer.from(Buffer.from(p, "base64url").toString().replace("1500", "9500")).toString("base64url")}.${s}`;
  assert.equal(verifyVoucher(tampered).valid, false);
  assert.equal(verifyVoucher("nonsense").valid, false);
  const st = await voucherStatus(v);
  assert.equal(st.redeemable, true); assert.equal(st.settlement, "held");
  assert.equal((await redeemVoucher(v, { amount: 2000, merchant: "OpenAI" })).ok, false); // above the authorisation
  const red = await redeemVoucher(v, { amount: 1400, merchant: "OpenAI", reference: "INV-1" });
  assert.ok(red.ok);
  if (red.ok) { assert.equal(red.result.transaction.settlement, "captured"); assert.equal(red.result.transaction.amount, 1400); assert.equal(red.result.released, 100); assert.equal(red.result.transaction.settledBy, "merchant:OpenAI"); }
  const twice = await redeemVoucher(v, { merchant: "OpenAI" });
  assert.equal(twice.ok, false); if (!twice.ok) assert.equal(twice.status, 409);
  assert.equal((await voucherStatus(v)).redeemable, false);
  // Expired vouchers are refused even though the signature is fine.
  const old = issueVoucher({ ...t, holdExpiresAt: new Date(Date.now() - 1000) }, r.mandate, "Test agent", "x")!;
  assert.equal(verifyVoucher(old).expired, true);
});

test("ledger anchoring: heads are signed into a public chain, verified, and cover receipts", async () => {
  const { anchorWorkspace, verifyAnchors, anchorCovering, latestAnchor, anchorHashOf, verifyAnchorSignature, anchorAll } = await import("../lib/anchors");
  const a1 = await anchorWorkspace(ws);
  assert.ok(a1); if (!a1) return;
  assert.equal(anchorHashOf(a1), a1.anchorHash); assert.equal(verifyAnchorSignature(a1), true);
  assert.equal(verifyAnchorSignature({ ...a1, anchorHash: "0".repeat(64) }), false);
  // The anchor's own ledger entry does not warrant another anchor; a real event does.
  assert.equal(await anchorWorkspace(ws), null);
  await mandate({ approvalAbove: null });
  const a2 = await anchorWorkspace(ws);
  assert.ok(a2 && a2.n === a1.n + 1 && a2.prevAnchorHash === a1.anchorHash && a2.seq > a1.seq);
  assert.equal(await anchorWorkspace(ws), null);
  const v = await verifyAnchors();
  assert.equal(v.ok, true); assert.ok(v.checked >= 2);
  const cover = await anchorCovering(ws, a1.seq);
  assert.equal(cover?.n, a1.n);
  assert.equal((await latestAnchor(ws))?.n, a2!.n);
  assert.equal(await anchorWorkspace(ws), null);
  assert.equal(typeof (await anchorAll()), "number");
  const { buildTransactionReceipt } = await import("../lib/receipts");
  const { shareTransaction, getTransaction } = await import("../lib/service");
  const r = await mandate({ approvalAbove: null });
  const t = await authorize(r.mandate, { amount: 100, merchant: "OpenAI" }, "agent_api");
  await anchorWorkspace(ws);
  const token = (await shareTransaction(ws, t.transactionId, "owner"))!;
  const receipt = await buildTransactionReceipt(t.transactionId, token, "https://mandate.test");
  assert.ok(receipt?.anchor && receipt.anchor.seq >= receipt.anchor.coversSeq && receipt.events.some((e) => e.seq === receipt.anchor!.coversSeq && e.type.startsWith("authorization.")), "receipt carries the anchor covering its decision rows");
  void getTransaction;
});

test("approval routing: the first matching route decides who is notified and is recorded on the request", async () => {
  const { addRoute, removeRoute, routeFor, toggleRoute } = await import("../lib/routing");
  const { notifyUserIds, deciderUserIds } = await import("../lib/notify");
  const { getApproval } = await import("../lib/service");
  const [u] = await db.select({ id: schema.user.id }).from(schema.member).innerJoin(schema.user, (await import("drizzle-orm")).eq(schema.user.id, schema.member.userId)).where((await import("drizzle-orm")).eq(schema.member.organizationId, ws)).limit(1);
  const uid2 = "test-user-" + randomUUID();
  await db.insert(schema.user).values({ id: uid2, name: "Viewer", email: `${uid2}@example.com`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  await db.insert(schema.member).values({ id: randomUUID(), organizationId: ws, userId: uid2, role: "viewer", createdAt: new Date() });
  assert.equal((await addRoute(ws, { name: "to a viewer", userIds: [uid2] }, "owner")).ok, false); // viewers cannot decide
  const big = await addRoute(ws, { name: "big spends", minAmount: 4000, userIds: [u.id], priority: 10 }, "owner");
  assert.ok(big.ok);
  const r = await mandate({ approvalAbove: 2000 });
  assert.equal(await routeFor(ws, { amount: 3000, merchant: "OpenAI", mandateId: r.mandate.id }), null);
  assert.equal((await routeFor(ws, { amount: 4500, merchant: "OpenAI", mandateId: r.mandate.id }))?.name, "big spends");
  const ask = await authorize(r.mandate, { amount: 4500, merchant: "OpenAI" }, "agent_api");
  assert.equal((await getApproval(ask.approvalId!))!.a.routeId, big.ok ? big.route.id : "");
  assert.deepEqual(await notifyUserIds(ws, big.ok ? big.route.id : null), [u.id]);
  assert.deepEqual((await notifyUserIds(ws, null)).sort(), (await deciderUserIds(ws)).sort());
  if (big.ok) { await toggleRoute(ws, big.route.id, false, "owner"); assert.equal(await routeFor(ws, { amount: 4500, merchant: "OpenAI", mandateId: r.mandate.id }), null); await removeRoute(ws, big.route.id, "owner"); }
});

test("sandbox mandates: test tokens, no proxy keys, out of the stats, resettable", async () => {
  const { resetSandbox, getMandateByToken, recentTransactions } = await import("../lib/service");
  const { statsRows } = await import("../lib/stats");
  const r = await mandate({ approvalAbove: null, sandbox: true });
  assert.ok(r.token.startsWith("mnd_test_")); assert.equal(r.mandate.sandbox, 1); assert.equal(r.mandate.tokenPrefix.length, 14);
  assert.equal((await getMandateByToken(r.token))?.id, r.mandate.id);
  assert.equal((await authorize(r.mandate, { amount: 700, merchant: "OpenAI" }, "agent_api")).decision, "approved");
  assert.equal((await statsRows(ws)).rows.some((x) => x.mid === r.mandate.id), false);
  const { createProxyKey, addProviderKey } = await import("../lib/proxy");
  const pk = await addProviderKey(ws, "openai", "sk-REAL-test-key-0000000000", "t", "owner");
  await assert.rejects(createProxyKey(ws, { mandateId: r.mandate.id, providerKeyId: pk.id, name: "x" }, "owner"), /sandbox/);
  assert.equal(await resetSandbox(ws, r.mandate.id, "owner"), true);
  assert.equal((await recentTransactions(ws, 10, r.mandate.id)).length, 0);
  const live = await mandate({ approvalAbove: null });
  assert.equal(await resetSandbox(ws, live.mandate.id, "owner"), false); // never wipes a live mandate
});

test("generic API targets: public https only, priced per call or from the response, keys bound to the target", async () => {
  const { addTarget, listTargets, createProxyKey, resolveTargetToken, targetCost, removeTarget, listProxyKeys } = await import("../lib/proxy");
  assert.equal((await addTarget(ws, { name: "Local", baseUrl: "http://10.0.0.5", authValue: "Bearer secret-1", pricing: "per_call", priceAmount: 5 }, "owner")).ok, false);
  const t = await addTarget(ws, { name: "SerpAPI", baseUrl: "https://example.com/api/", authHeader: "X-Api-Key", authValue: "sk-live-000000", pricing: "header", priceAmount: 50, priceKey: "x-cost-cents" }, "owner");
  assert.ok(t.ok); if (!t.ok) return;
  assert.equal(t.target.slug, "serpapi"); assert.equal(t.target.baseUrl, "https://example.com/api"); assert.equal(t.target.authHeader, "x-api-key");
  assert.equal((await addTarget(ws, { name: "SerpAPI", baseUrl: "https://example.com", authValue: "Bearer xx-yy-zz", pricing: "per_call", priceAmount: 1 }, "owner")).ok, false); // duplicate slug
  assert.equal(targetCost(t.target, { status: 200, headers: new Headers({ "x-cost-cents": "37" }), body: null }).amount, 37);
  assert.equal(targetCost(t.target, { status: 200, headers: new Headers(), body: null }).amount, 50); // estimate when missing
  assert.equal(targetCost(t.target, { status: 500, headers: new Headers({ "x-cost-cents": "37" }), body: null }).amount, 0);
  assert.equal(targetCost({ ...t.target, pricing: "json", priceKey: "usage.cost" }, { status: 200, headers: new Headers(), body: JSON.stringify({ usage: { cost: 12 } }) }).amount, 12);
  assert.equal(targetCost({ ...t.target, pricing: "per_call", priceAmount: 9 }, { status: 200, headers: new Headers(), body: null }).amount, 9);
  const m = await mandate({ approvalAbove: null, allowedMerchants: [] });
  const k = await createProxyKey(ws, { mandateId: m.mandate.id, targetId: t.target.id, name: "scraper" }, "owner");
  assert.ok(k.token.startsWith("mpx_"));
  const resolved = await resolveTargetToken(k.token, "serpapi");
  assert.equal(resolved?.authValue, "sk-live-000000"); assert.equal(resolved?.target.id, t.target.id);
  assert.equal(await resolveTargetToken(k.token, "other"), null);
  assert.ok((await listProxyKeys(ws)).some((x) => x.k.id === k.id && x.targetName === "SerpAPI"));
  assert.equal((await listTargets(ws)).length, 1);
  await removeTarget(ws, t.target.id, "owner");
  assert.equal(await resolveTargetToken(k.token, "serpapi"), null); // keys die with the target
});
