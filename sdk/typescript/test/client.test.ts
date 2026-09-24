import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Mandate, MandateDeclined, MandatePending, MandateAuthError } from "../src/index.js";
import { dispatch, openaiTools } from "../src/openai.js";

const calls: { method: string; path: string; body: Record<string, unknown>; headers: Record<string, string | string[] | undefined> }[] = [];
let pendingLeft = 0;
const srv = createServer((req, res) => {
  let raw = ""; req.on("data", (c) => { raw += c; }); req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ method: req.method!, path: req.url!, body, headers: req.headers });
    const send = (status: number, b: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    if (req.headers.authorization !== "Bearer mnd_test") return send(401, { error: "Unknown mandate token." });
    if (req.method === "GET" && req.url === "/api/agent/mandate") return send(200, { mandate: "M", remaining: { today: 5000 } });
    if (req.url === "/api/agent/authorize") {
      if (body.amount > 5000) return send(403, { decision: "declined", rule: "per_txn", reason: "too big", transactionId: "t1", remedy: { message: "Split it.", maxAmountNow: 5000 } });
      if (body.merchant === "Slow") { if (pendingLeft > 0) { pendingLeft--; return send(202, { decision: "pending", rule: "approval", reason: "ask", transactionId: "t2", approvalId: "a1", remedy: { approvalRequired: true, message: "wait" } }); } return send(200, { decision: "approved", rule: "allowance", reason: "ok", transactionId: "t2", settlement: "held" }); }
      return send(200, { decision: "approved", rule: "limits", reason: "ok", transactionId: "t3", settlement: "held" });
    }
    if (req.url === "/api/agent/capture") return send(200, { transactionId: body.transactionId, settlement: "captured", capturedAmount: body.amount ?? 1000, released: 0 });
    if (req.url === "/api/agent/void") return send(200, { transactionId: body.transactionId, settlement: "voided" });
    send(404, { error: "no" });
  });
});
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
const m = new Mandate("mnd_test", { baseUrl: base });

test("token required; bad token is an auth error", async () => {
  assert.throws(() => new Mandate("nope"), MandateAuthError);
  await assert.rejects(new Mandate("mnd_wrong", { baseUrl: base }).mandate(), MandateAuthError);
});

test("authorize sends the idempotency key; capture reports what was paid", async () => {
  const d = await m.authorize({ amount: 1299, merchant: "OpenAI", purpose: "credits", idempotencyKey: "k1" });
  assert.equal(d.decision, "approved"); assert.equal(d.settlement, "held");
  assert.equal(calls.at(-1)!.headers["idempotency-key"], "k1");
  const c = await m.capture(d.transactionId, { amount: 1199, note: "order 1" });
  assert.equal(c.capturedAmount, 1199);
});

test("declined carries a remedy; mustAuthorize throws it", async () => {
  const d = await m.authorize({ amount: 9000, merchant: "OpenAI" });
  assert.equal(d.remedy?.maxAmountNow, 5000);
  await assert.rejects(m.mustAuthorize({ amount: 9000, merchant: "OpenAI" }), (e: unknown) => e instanceof MandateDeclined && e.remedy?.maxAmountNow === 5000);
});

test("withHold captures on success and voids on error or null", async () => {
  const r = await m.withHold({ amount: 100, merchant: "OpenAI" }, async () => ({ paid: 90, note: "x", result: "ok" }));
  assert.equal(r.state.settlement, "captured"); assert.equal(r.result, "ok"); assert.equal(calls.at(-1)!.body.amount, 90);
  await assert.rejects(m.withHold({ amount: 100, merchant: "OpenAI" }, async () => { throw new Error("checkout failed"); }), /checkout failed/);
  assert.equal(calls.at(-1)!.path, "/api/agent/void");
  await m.withHold({ amount: 100, merchant: "OpenAI" }, async () => null);
  assert.equal(calls.at(-1)!.path, "/api/agent/void");
});

test("pending is polled with waitForMs, then throws from mustAuthorize when it never resolves", async () => {
  pendingLeft = 2;
  const before = calls.filter((c) => c.path === "/api/agent/authorize").length;
  const d = await m.authorize({ amount: 100, merchant: "Slow", idempotencyKey: "k2", waitForMs: 5000, pollEveryMs: 5 });
  assert.equal(d.decision, "approved");
  assert.equal(calls.filter((c) => c.path === "/api/agent/authorize").length - before, 3);
  pendingLeft = 100;
  await assert.rejects(m.mustAuthorize({ amount: 100, merchant: "Slow" }), MandatePending);
});

test("openai tools dispatch", async () => {
  assert.deepEqual(openaiTools().map((t) => t.function.name), ["check_mandate", "request_purchase", "capture_purchase", "void_purchase"]);
  const r = (await dispatch(m, "request_purchase", JSON.stringify({ amount: 100, merchant: "OpenAI" }))) as { decision: string };
  assert.equal(r.decision, "approved");
  srv.close();
});
