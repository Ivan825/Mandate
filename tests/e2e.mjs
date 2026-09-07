// End-to-end: starts the built app and a fake LLM upstream, then drives the
// product through a real browser and real HTTP the way a person and an agent
// would. Requires `npm run build` first, DATABASE_URL, and Playwright's
// Chromium (npx playwright install chromium). Exit code is the verdict.

import { spawn } from "node:child_process";
import http from "node:http";
import crypto from "node:crypto";
import { chromium } from "playwright";

const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE = `http://localhost:${PORT}`;
const UP = 3198;
let failures = 0;
const check = (name, cond, extra = "") => { console.log(`${cond ? "ok " : "FAIL"} ${name}${extra ? " — " + extra : ""}`); if (!cond) failures++; };

// ---- fake provider upstream ----
const upstream = http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  const auth = String(req.headers["authorization"] ?? req.headers["x-api-key"] ?? req.headers["x-goog-api-key"] ?? "");
  if (!auth.includes("REAL")) { res.writeHead(401, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: "bad key" } })); }
  let j = {}; try { j = JSON.parse(body); } catch {}
  if (j.stream) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n');
    res.write('data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":30}}\n\ndata: [DONE]\n\n'); return res.end();
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { content: "Hello" } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
}).listen(UP);

// Rate-limit windows persist in Postgres; a fresh run must not inherit the
// previous run's sign-in attempts from the same address.
{
  const { Client } = await import("pg");
  const c = new Client({ connectionString: process.env.DATABASE_URL ?? "postgres://mandate:mandate@localhost:5432/mandate" });
  await c.connect(); await c.query("delete from rate_limit"); await c.query("delete from rate_limits"); await c.end();
}

// ---- app server, stdout captured for sign-in links ----
let out = "";
const app = spawn("npx", ["next", "start", "-p", String(PORT)], { env: {
  ...process.env, ALLOW_SEED: "1", APP_URL: BASE, PROXY_UPSTREAM_OPENAI: `http://localhost:${UP}/openai`,
  // `next start` is production mode, so the same keys a deployment needs
  // (BETTER_AUTH_SECRET and NOTIFY_SECRET come from .env or the CI env).
  MANDATE_ENCRYPTION_KEY: process.env.MANDATE_ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString("base64"),
  RECEIPT_SIGNING_KEY: process.env.RECEIPT_SIGNING_KEY ?? Buffer.alloc(32, 9).toString("base64"),
}, stdio: ["ignore", "pipe", "pipe"] });
app.stdout.on("data", (d) => { out += d.toString(); });
app.stderr.on("data", (d) => { out += d.toString(); });
const waitFor = async (url, ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { try { const r = await fetch(url); if (r.ok || r.status === 307) return; } catch {} await new Promise((r) => setTimeout(r, 500)); } throw new Error("server did not start:\n" + out.slice(-800)); };
const lastLink = (re) => [...out.matchAll(re)].pop()?.[0];

try {
  await waitFor(BASE + "/");
  const b = await chromium.launch({ executablePath: process.env.PW_CHROMIUM });
  const ctx = await b.newContext();
  const p = await ctx.newPage();

  // 1. landing + sign-in by email link
  await p.goto(BASE + "/", { waitUntil: "networkidle" });
  check("landing renders", (await p.locator("h1").first().textContent())?.includes("sanction"));
  const email = `e2e-${Date.now()}@example.com`;
  await p.goto(BASE + "/sign-in", { waitUntil: "networkidle" });
  await p.fill("#email", email); await p.click("form.form button[type=submit]");
  await p.waitForSelector(".notice.ok"); await new Promise((r) => setTimeout(r, 800));
  const link = lastLink(new RegExp(`${BASE}/api/auth/magic-link/verify\\?[^\\s]+`, "g"));
  check("sign-in link printed", Boolean(link));
  await p.goto(link, { waitUntil: "networkidle" });
  check("signed in to onboarding", (await p.locator(".steps li").count()) === 4);

  // 2. seed + inbox approval
  const seed = await p.evaluate(async () => (await fetch("/api/dev/seed", { method: "POST" })).json());
  check("seed decisions", seed.decisions?.join(",") === "approved,approved,declined,pending,declined,approved,pending", seed.decisions?.join(","));
  await p.goto(BASE + "/approvals", { waitUntil: "networkidle" });
  await p.locator(".approval", { hasText: "Anthropic" }).first().getByRole("button", { name: "Approve once" }).click();
  await p.waitForURL(/\/approvals$/); await p.waitForTimeout(500);
  const retry = await fetch(BASE + "/api/agent/authorize", { method: "POST", headers: { authorization: "Bearer " + seed.tokens.dev, "content-type": "application/json" }, body: JSON.stringify({ amount: 4500, merchant: "Anthropic", purpose: "Top-up before the demo" }) }).then((r) => r.json());
  check("agent retry approved by allowance", retry.rule === "allowance", retry.reason);
  // Idempotency: a pending answer is never replayed; the retry after approval consumes the allowance.
  const idem = { authorization: "Bearer " + seed.tokens.dev, "content-type": "application/json", "idempotency-key": "e2e-" + Date.now() };
  const body = JSON.stringify({ amount: 2100, merchant: "Anthropic", purpose: "idempotent ask" });
  const a1 = await fetch(BASE + "/api/agent/authorize", { method: "POST", headers: idem, body });
  const a2 = await fetch(BASE + "/api/agent/authorize", { method: "POST", headers: idem, body });
  check("pending is not cached as a replay", a1.status === 202 && a2.status === 202 && !a2.headers.get("idempotent-replayed"), `${a1.status} ${a2.status} ${JSON.stringify(await a2.clone().json())}`);
  await p.goto(BASE + "/approvals", { waitUntil: "networkidle" });
  await p.locator(".approval", { hasText: "idempotent ask" }).first().getByRole("button", { name: "Approve once" }).click();
  await p.waitForURL(/\/approvals$/); await p.waitForTimeout(400);
  const a3 = await fetch(BASE + "/api/agent/authorize", { method: "POST", headers: idem, body });
  const a4 = await fetch(BASE + "/api/agent/authorize", { method: "POST", headers: idem, body });
  check("approved answer is replayed exactly", a3.status === 200 && a4.status === 200 && a4.headers.get("idempotent-replayed") === "true");
  const big = await fetch(BASE + "/api/agent/authorize", { method: "POST", headers: idem, body: JSON.stringify({ amount: 2 ** 40, merchant: "Anthropic" }) });
  check("oversized amount rejected", big.status === 400);

  // 3. invite an approver, accept in a second browser
  await p.goto(BASE + "/members", { waitUntil: "networkidle" });
  await p.fill("#email", `partner-${Date.now()}@example.com`); await p.selectOption("#role", "approver");
  await Promise.all([p.waitForURL(/invited=/), p.click("form.card button[type=submit]")]);
  const invite = lastLink(new RegExp(`${BASE}/invite/[^\\s]+`, "g"));
  check("invitation link printed", Boolean(invite));
  const partnerEmail = decodeURIComponent(p.url().split("invited=")[1]);
  const ctx2 = await b.newContext(); const p2 = await ctx2.newPage();
  await p2.goto(BASE + "/sign-in", { waitUntil: "networkidle" }); await p2.fill("#email", partnerEmail); await p2.click("form.form button[type=submit]");
  await p2.waitForSelector(".notice.ok"); await new Promise((r) => setTimeout(r, 800));
  await p2.goto(lastLink(new RegExp(`${BASE}/api/auth/magic-link/verify\\?[^\\s]+`, "g")), { waitUntil: "networkidle" });
  await p2.goto(invite, { waitUntil: "networkidle" });
  await Promise.all([p2.waitForURL(/joined=1/), p2.click(".card form button[type=submit]")]);
  await p2.goto(BASE + "/settings", { waitUntil: "networkidle" });
  check("partner joined as approver", (await p2.locator("p.muted").first().textContent())?.includes("approver"));
  check("approver cannot see Issue mandate", (await p2.locator("a.btn.accent", { hasText: "Issue mandate" }).count()) === 0);
  await p2.goto(BASE + "/mandates/new", { waitUntil: "networkidle" });
  check("approver is turned away from /mandates/new with a reason", p2.url().includes("error="), p2.url());
  // Webhook targets must be public: a private address is refused.
  await p2.goto(BASE + "/settings", { waitUntil: "networkidle" });
  await p2.selectOption("select[name=type]", "webhook"); await p2.fill("input[name=target]", "http://169.254.169.254/latest/meta-data");
  await Promise.all([p2.waitForURL(/settings\?(error|channel)=/), p2.locator("form", { has: p2.locator("select[name=type]") }).locator("button[type=submit]").click()]);
  check("private webhook target refused", p2.url().includes("error="));

  // 4. proxy: provider key + proxy key + a metered call, streaming included
  await p.goto(BASE + "/proxy", { waitUntil: "networkidle" });
  await p.selectOption("#provider", "openai"); await p.fill("#key", "sk-REAL-e2e-key-000000"); await p.fill("#label", "e2e");
  await Promise.all([p.waitForURL(/added=provider/), p.click("form.form button.secondary[type=submit]")]);
  await p.fill("#name", "e2e agent");
  await Promise.all([p.waitForURL(/reveal=/), p.click("form.form button.accent[type=submit]")]);
  const mpx = (await p.locator(".token").textContent())?.trim();
  check("proxy key revealed once", Boolean(mpx?.startsWith("mpx_")));
  const call = await fetch(BASE + "/api/proxy/openai/chat/completions", { method: "POST", headers: { authorization: "Bearer " + mpx, "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-4o-mini", max_tokens: 50, messages: [{ role: "user", content: "hi" }] }) });
  check("proxy forwards and settles", call.status === 200 && Boolean(call.headers.get("x-mandate-transaction")));
  const stream = await fetch(BASE + "/api/proxy/openai/chat/completions", { method: "POST", headers: { authorization: "Bearer " + mpx, "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-4o", stream: true, messages: [{ role: "user", content: "hi" }] }) });
  const streamed = await stream.text();
  check("proxy streams through", stream.status === 200 && streamed.includes("[DONE]"));
  const files = await fetch(BASE + "/api/proxy/openai/files", { method: "POST", headers: { authorization: "Bearer " + mpx, "content-type": "application/json" }, body: "{}" });
  const dots = await fetch(BASE + "/api/proxy/openai/chat/../files", { method: "POST", headers: { authorization: "Bearer " + mpx, "content-type": "application/json" }, body: "{}" });
  check("proxy refuses non-generation endpoints", files.status === 404 && dots.status === 404, `${files.status} ${dots.status}`);
  const bad = await fetch(BASE + "/api/proxy/openai/chat/completions", { method: "POST", headers: { authorization: "Bearer mpx_nope", "content-type": "application/json" }, body: "{}" });
  check("proxy rejects unknown key", bad.status === 401);

  // 5. MCP OAuth: register, authorise via consent, call a tool
  const reg = await fetch(BASE + "/api/auth/oauth2/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "E2E Agent", application_type: "native", redirect_uris: ["http://127.0.0.1:9/cb"], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none", scope: "mandate:read mandate:spend" }) }).then((r) => r.json());
  check("dynamic client registration", Boolean(reg.client_id));
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const authz = `${BASE}/api/auth/oauth2/authorize?response_type=code&client_id=${reg.client_id}&redirect_uri=${encodeURIComponent("http://127.0.0.1:9/cb")}&scope=${encodeURIComponent("mandate:read mandate:spend")}&code_challenge=${challenge}&code_challenge_method=S256&state=s1&resource=${encodeURIComponent(BASE + "/api/mcp")}`;
  let redirected = "";
  p.on("request", (r) => { if (r.url().startsWith("http://127.0.0.1:9/cb")) redirected = r.url(); });
  await p.goto(authz, { waitUntil: "networkidle" });
  check("consent page shows client", (await p.locator("h1").textContent())?.includes("E2E Agent"));
  await p.getByRole("button", { name: "Allow" }).click(); await p.waitForTimeout(2500);
  const code = redirected ? new URL(redirected).searchParams.get("code") : null;
  check("authorisation code issued", Boolean(code));
  const tok = await fetch(BASE + "/api/auth/oauth2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: code ?? "", redirect_uri: "http://127.0.0.1:9/cb", client_id: reg.client_id, code_verifier: verifier, resource: BASE + "/api/mcp" }) }).then((r) => r.json());
  check("access token with scopes", tok.scope === "mandate:read mandate:spend");
  const mcp = async (body) => fetch(BASE + "/api/mcp", { method: "POST", headers: { authorization: "Bearer " + tok.access_token, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) }).then((r) => r.text());
  const list = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  check("mcp tools listed", list.includes("request_purchase"));
  const lm = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_mandates", arguments: {} } });
  const inner = JSON.parse(JSON.parse((lm.split("\n").find((l) => l.startsWith("data:")) ?? lm).replace(/^data:\s*/, "")).result.content[0].text);
  const usd = inner.mandates.find((m) => m.currency === "USD");
  const rp = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "request_purchase", arguments: { mandateId: usd.mandateId, amount: 150, merchant: "GitHub", purpose: "e2e" } } });
  check("mcp purchase approved", rp.includes('\\"decision\\": \\"approved\\"'));

  // 6. receipt: signed, verifiable through the public endpoint
  const cookie = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const receipt = await fetch(BASE + "/api/ledger/export", { headers: { cookie } }).then((r) => r.json());
  check("receipt signed", Boolean(receipt.signature?.signature) && receipt.verification.ok);
  const v = await fetch(BASE + "/api/receipts/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(receipt) }).then((r) => r.json());
  check("public verifier accepts receipt", v.chainOk && v.signatureValid && v.signedByThisServer, JSON.stringify(v));
  receipt.events[0].payload.name = "tampered";
  const v2 = await fetch(BASE + "/api/receipts/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(receipt) }).then((r) => r.json());
  check("public verifier rejects tampering", v2.chainOk === false);

  // 7. discovery
  const prm = await fetch(BASE + "/.well-known/oauth-protected-resource/api/mcp").then((r) => r.json());
  check("oauth discovery at root", prm.resource === BASE + "/api/mcp");

  await b.close();
} catch (e) {
  failures++;
  console.log("FAIL exception:", e?.message ?? e);
  console.log(out.slice(-1500));
} finally {
  app.kill("SIGTERM"); upstream.close();
}
console.log(failures ? `\n${failures} failure(s)` : "\nall e2e checks passed");
process.exit(failures ? 1 : 0);
