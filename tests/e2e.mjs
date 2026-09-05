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

// ---- app server, stdout captured for sign-in links ----
let out = "";
const app = spawn("npx", ["next", "start", "-p", String(PORT)], { env: { ...process.env, ALLOW_SEED: "1", APP_URL: BASE, PROXY_UPSTREAM_OPENAI: `http://localhost:${UP}/openai` }, stdio: ["ignore", "pipe", "pipe"] });
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
  const seed = await p.evaluate(async () => (await fetch("/api/dev/seed")).json());
  check("seed decisions", seed.decisions?.join(",") === "approved,approved,declined,pending,declined,approved,pending", seed.decisions?.join(","));
  await p.goto(BASE + "/approvals", { waitUntil: "networkidle" });
  await p.locator(".approval", { hasText: "Anthropic" }).first().getByRole("button", { name: "Approve once" }).click();
  await p.waitForURL(/\/approvals$/); await p.waitForTimeout(500);
  const retry = await fetch(BASE + "/api/agent/authorize", { method: "POST", headers: { authorization: "Bearer " + seed.tokens.dev, "content-type": "application/json" }, body: JSON.stringify({ amount: 4500, merchant: "Anthropic", purpose: "Top-up before the demo" }) }).then((r) => r.json());
  check("agent retry approved by allowance", retry.rule === "allowance", retry.reason);

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
  const rp = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "request_purchase", arguments: { mandateId: usd.mandateId, amount: 1500, merchant: "GitHub", purpose: "e2e" } } });
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
