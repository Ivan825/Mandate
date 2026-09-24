// End-to-end: starts the built app and a fake LLM upstream, then drives the
// product through a real browser and real HTTP the way a person and an agent
// would. Requires `npm run build` first, DATABASE_URL, and Playwright's
// Chromium (npx playwright install chromium). Exit code is the verdict.

import { spawn } from "node:child_process";
import http from "node:http";
import crypto from "node:crypto";
import { chromium } from "playwright";
import Stripe from "stripe";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

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
  // Fake Stripe keys: the webhook is exercised with locally signed events;
  // nothing calls Stripe's API.
  STRIPE_SECRET_KEY: "sk_test_e2e_fake", STRIPE_WEBHOOK_SECRET: "whsec_e2e_fake", STRIPE_PUBLISHABLE_KEY: "pk_test_e2e_fake", STRIPE_ISSUING_REGION: "US",
  // Push: real VAPID keys so subscriptions register; nothing is sent to a real browser.
  ...(() => { const { generateVAPIDKeys } = require("web-push"); const k = generateVAPIDKeys(); return { VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey, VAPID_SUBJECT: "mailto:e2e@example.com" }; })(),
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
  check("seed decisions", seed.decisions?.join(",") === "approved,approved,declined,pending,declined,approved,pending,approved,approved", seed.decisions?.join(","));
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

  // 2b. holds: the approved answer is a hold; capture less, then it is closed.
  const approved = await a3.clone().json();
  check("approval is a hold with an expiry", approved.settlement === "held" && typeof approved.holdExpiresAt === "string" && approved.next?.includes("/api/agent/capture"), JSON.stringify(approved));
  const tokenHdr = { authorization: "Bearer " + seed.tokens.dev, "content-type": "application/json" };
  const cap = await fetch(BASE + "/api/agent/capture", { method: "POST", headers: tokenHdr, body: JSON.stringify({ transactionId: approved.transactionId, amount: 1500, note: "e2e capture" }) });
  const capBody = await cap.json();
  check("capture for less releases the difference", cap.status === 200 && capBody.settlement === "captured" && capBody.capturedAmount === 1500 && capBody.released === 600, JSON.stringify(capBody));
  const cap2 = await fetch(BASE + "/api/agent/capture", { method: "POST", headers: tokenHdr, body: JSON.stringify({ transactionId: approved.transactionId }) });
  check("second capture is refused with the current state", cap2.status === 409 && (await cap2.json()).state?.settlement === "captured");
  const st = await fetch(BASE + "/api/agent/transactions/" + approved.transactionId, { headers: tokenHdr }).then((r) => r.json());
  check("transaction state readable by the agent", st.settlement === "captured" && st.settledBy === "agent");
  const otherTok = { authorization: "Bearer " + seed.tokens.home, "content-type": "application/json" };
  const cross = await fetch(BASE + "/api/agent/void", { method: "POST", headers: otherTok, body: JSON.stringify({ transactionId: approved.transactionId }) });
  check("another mandate's token cannot settle this hold", cross.status === 404);
  // 2c. remedies: a decline says what would pass and when.
  const tooBig = await fetch(BASE + "/api/agent/authorize", { method: "POST", headers: tokenHdr, body: JSON.stringify({ amount: 99999, merchant: "OpenAI" }) }).then((r) => r.json());
  check("decline carries a remedy with the max that would pass now", tooBig.rule === "per_txn" && Number.isInteger(tooBig.remedy?.maxAmountNow) && /pass/.test(tooBig.remedy?.message ?? ""), JSON.stringify(tooBig.remedy));
  const wrongShop = await fetch(BASE + "/api/agent/authorize", { method: "POST", headers: tokenHdr, body: JSON.stringify({ amount: 100, merchant: "Namecheap" }) }).then((r) => r.json());
  check("merchant decline lists the allowed merchants", wrongShop.rule === "merchant" && wrongShop.remedy?.allowedMerchants?.includes("OpenAI"));
  const mandateInfo = await fetch(BASE + "/api/agent/mandate", { headers: tokenHdr }).then((r) => r.json());
  check("agent sees its open holds", Array.isArray(mandateInfo.holds?.open) && mandateInfo.holds.open.length >= 1 && mandateInfo.holds.ttlHours === 24, JSON.stringify(mandateInfo.holds));
  // 2d. the owner sees holds and the activity feed reads as sentences
  await p.goto(BASE + "/mandates/" + mandateInfo.mandateId, { waitUntil: "networkidle" });
  check("mandate page shows held and captured decisions", (await p.locator(".pill.held").count()) >= 1 && (await p.locator(".pill.captured").count()) >= 1);
  await p.goto(BASE + "/activity", { waitUntil: "networkidle" });
  const feedText = await p.locator("article").allTextContents();
  check("activity feed renders decisions as sentences", feedText.length >= 5 && feedText.some((t) => /was allowed|captured/.test(t)), String(feedText.length));
  await p.fill("article input[name=body] >> nth=0", "Looked into this — fine.");
  await Promise.all([p.waitForURL(/\/activity/), p.locator("article form >> nth=0").locator("button", { hasText: "Note" }).first().click()]);
  await p.waitForTimeout(400);
  check("a note attaches to an event", (await p.locator("article", { hasText: "Looked into this" }).count()) >= 1);
  await p.goto(BASE + "/activity?group=decisions&outcome=captured", { waitUntil: "networkidle" });
  check("activity filters narrow the feed", (await p.locator("article").count()) >= 1 && (await p.locator("article", { hasText: "authorization.captured" }).count()) >= 1);
  // 2d′. pause, raise, share, templates, wizard, push, one-tap API
  await p.goto(BASE + "/mandates/" + mandateInfo.mandateId, { waitUntil: "networkidle" });
  await p.locator("details.menu summary", { hasText: "Pause" }).click();
  await p.selectOption("#pause-hours", "1");
  await Promise.all([p.waitForURL(/\/mandates\//), p.locator("form", { has: p.locator("#pause-hours") }).locator("button[type=submit]").click()]);
  await p.waitForTimeout(300);
  const pausedTry = await fetch(BASE + "/api/agent/authorize", { method: "POST", headers: tokenHdr, body: JSON.stringify({ amount: 100, merchant: "OpenAI" }) }).then((r) => r.json());
  check("paused mandate declines with a resume time", pausedTry.rule === "paused" && typeof pausedTry.remedy?.retryAt === "string", JSON.stringify(pausedTry));
  check("mandate page shows paused", (await p.locator(".pill.paused").count()) >= 1);
  await Promise.all([p.waitForURL(/\/mandates\//), p.locator("button", { hasText: "Resume now" }).click()]);
  await p.waitForTimeout(300);
  check("resumed mandate approves again", (await fetch(BASE + "/api/agent/authorize", { method: "POST", headers: tokenHdr, body: JSON.stringify({ amount: 100, merchant: "OpenAI" }) }).then((r) => r.json())).decision === "approved");
  // Temporary raise: 45.00 exceeds what is left of today's 150.00 until the daily limit is raised to 300.00 (then it escalates above the 20.00 threshold: pending, not daily).
  const beforeRaise = await fetch(BASE + "/api/agent/authorize", { method: "POST", headers: tokenHdr, body: JSON.stringify({ amount: 4500, merchant: "OpenAI" }) }).then((r) => r.json());
  check("daily limit binds before the raise", beforeRaise.rule === "daily", beforeRaise.rule);
  await p.locator("details.menu summary", { hasText: "Raise a limit" }).click();
  await p.selectOption("#raise-field", "daily"); await p.fill("#raise-amount", "300"); await p.selectOption("#raise-hours", "1");
  await Promise.all([p.waitForURL(/raised=1/), p.locator("form", { has: p.locator("#raise-field") }).locator("button[type=submit]").click()]);
  await p.waitForLoadState("networkidle");
  const raisedTry = await fetch(BASE + "/api/agent/authorize", { method: "POST", headers: tokenHdr, body: JSON.stringify({ amount: 4500, merchant: "OpenAI" }) }).then((r) => r.json());
  check("temporary raise lifts the daily limit", raisedTry.rule !== "daily" && raisedTry.decision === "pending", JSON.stringify({ decision: raisedTry.decision, rule: raisedTry.rule }));
  await p.goto(BASE + "/mandates/" + mandateInfo.mandateId, { waitUntil: "networkidle" });
  check("mandate page shows the raise in force", (await p.locator("text=Raises in force").count()) === 1);
  // Share a receipt, verify its JSON, then stop sharing.
  await p.goto(BASE + "/mandates/" + mandateInfo.mandateId, { waitUntil: "networkidle" });
  await p.locator("button", { hasText: "Share receipt" }).first().click();
  await p.waitForSelector('a[href^="/r/"]', { timeout: 15000 });
  const receiptHref = await p.locator('a[href^="/r/"]').first().getAttribute("href");
  check("decision shared with a public link", Boolean(receiptHref?.includes("?k=")), String(receiptHref));
  const pubCtx = await b.newContext(); const pub = await pubCtx.newPage();
  await pub.goto(BASE + receiptHref, { waitUntil: "networkidle" });
  check("public receipt renders without a session", (await pub.locator("h1").textContent())?.includes("at ") && (await pub.locator("table tbody tr").count()) >= 1);
  const rj = await fetch(BASE + "/api/receipts/tx/" + receiptHref.split("/r/")[1].replace("?k=", "?k=")).then((r) => r.json());
  check("receipt JSON is signed", rj.kind === "mandate-transaction-receipt" && rj.signature?.alg === "Ed25519" && rj.events.length >= 1);
  const rv = await fetch(BASE + "/api/receipts/tx/" + rj.transaction.id, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(rj) }).then((r) => r.json());
  check("server verifier accepts the receipt", rv.coreOk && rv.signatureValid, JSON.stringify(rv));
  const tampered = { ...rj, transaction: { ...rj.transaction, amount: 1 } };
  const rv2 = await fetch(BASE + "/api/receipts/tx/" + rj.transaction.id, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(tampered) }).then((r) => r.json());
  check("server verifier rejects a tampered receipt", rv2.coreOk === false);
  await pub.locator("button", { hasText: "Verify in my browser" }).click();
  await pub.waitForSelector(".notice.ok, .notice.bad", { timeout: 15000 });
  check("receipt verifies in the browser", (await pub.locator(".notice.ok", { hasText: "Verified" }).count()) === 1, await pub.locator(".notice").last().textContent());
  await pubCtx.close();
  await p.locator("button", { hasText: "Stop sharing" }).first().click();
  await p.waitForFunction(() => document.querySelectorAll('a[href^="/r/"]').length === 0, null, { timeout: 15000 });
  check("un-shared receipt is gone", (await fetch(BASE + receiptHref)).status === 404);
  // Templates and duplicate pre-fill the issue form.
  await p.goto(BASE + "/mandates/new?template=shopping", { waitUntil: "networkidle" });
  check("template pre-fills the form", (await p.inputValue("#name")) === "Shopping assistant" && (await p.inputValue("#activeHoursStart")) === "7");
  await p.goto(BASE + "/mandates/new?from=" + mandateInfo.mandateId, { waitUntil: "networkidle" });
  check("duplicate pre-fills from the mandate", (await p.inputValue("#name")).endsWith("(copy)") && (await p.inputValue("#allowedMerchants")).includes("OpenAI"));
  // Connect wizard renders every rail with the live check.
  for (const rail of ["claude", "python", "curl"]) { await p.goto(BASE + "/connect?rail=" + rail, { waitUntil: "networkidle" }); check(`connect wizard renders rail ${rail}`, (await p.locator(".rails a.on").count()) === 1 && (await p.locator(".pulse").count()) === 1); }
  // Push: a subscription registers and lists.
  const pushInfo = await p.evaluate(async () => (await fetch("/api/push/subscribe")).json());
  check("push is configured with a VAPID key", pushInfo.enabled === true && typeof pushInfo.publicKey === "string");
  const subRes = await p.evaluate(async () => (await fetch("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: "https://push.example.test/sub/" + Math.random(), keys: { p256dh: "BPl", auth: "abc" } }) })).status);
  const pushAfter = await p.evaluate(async () => (await fetch("/api/push/subscribe")).json());
  check("push subscription registers and lists", subRes === 200 && pushAfter.devices.length === 1);
  // One-tap API decides with the signed link the (console) email carried — the owner needs an email channel first.
  await p.goto(BASE + "/settings", { waitUntil: "networkidle" });
  await p.selectOption("select[name=type]", "email"); await p.fill("input[name=target]", email);
  await Promise.all([p.waitForURL(/settings\?(error|channel)=/), p.locator("form", { has: p.locator("select[name=type]") }).locator("button[type=submit]").click()]);
  check("owner added an email channel", p.url().includes("channel=added"), p.url());
  const pend = await fetch(BASE + "/api/agent/authorize", { method: "POST", headers: tokenHdr, body: JSON.stringify({ amount: 3300, merchant: "Anthropic", purpose: "one-tap api" }) }).then((r) => r.json());
  await new Promise((r) => setTimeout(r, 800));
  const approveLink = lastLink(new RegExp(`${BASE}/a/${pend.approvalId}\\?d=approve&t=[^\\s]+`, "g"));
  check("approval email carried a signed approve link", Boolean(approveLink));
  const onetap = await fetch(approveLink.replace("/a/", "/api/approvals/onetap/"), { method: "POST" });
  check("one-tap API approves with the signed link", onetap.status === 200 && (await onetap.json()).decision === "approved");
  check("one-tap API refuses a replay", (await fetch(approveLink.replace("/a/", "/api/approvals/onetap/"), { method: "POST" })).status === 409);
  check("manifest and service worker are public", (await fetch(BASE + "/manifest.webmanifest")).status === 200 && (await fetch(BASE + "/sw.js")).status === 200);

  // 2e. event webhooks: settings page, private target refused
  await p.goto(BASE + "/settings/webhooks", { waitUntil: "networkidle" });
  check("event webhooks page renders", (await p.locator("h1").textContent())?.includes("pushed to your own systems"));
  await p.fill("#url", "http://10.0.0.8/hook");
  await Promise.all([p.waitForURL(/webhooks\?(error|reveal)=/), p.click("form.card button.accent[type=submit]")]);
  check("private event-webhook target refused", p.url().includes("error="));

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

  // 4b. Cards: a signed Stripe webhook drives the real-time authorisation and
  // the prepaid balance, without ever calling Stripe.
  {
    const run = Date.now().toString(36);
    const { Client } = await import("pg");
    const c = new Client({ connectionString: process.env.DATABASE_URL ?? "postgres://mandate:mandate@localhost:5432/mandate" });
    await c.connect();
    const { rows: [home] } = await c.query("select id, workspace_id from mandates where currency = 'INR' and workspace_id = $1 limit 1", [seed.workspace]);
    await c.query("update mandates set stripe_card_id = $2, stripe_cardholder_id = 'ich_e2e', card_last4 = '4242', card_status = 'active' where id = $1", [home.id, "ic_e2e_" + run]);
    await c.end();
    const stripe = new Stripe("sk_test_e2e_fake");
    const send = async (type, object, id = "evt_" + crypto.randomUUID()) => {
      const payload = JSON.stringify({ id, object: "event", type, data: { object } });
      const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_e2e_fake" });
      const r = await fetch(BASE + "/api/webhooks/stripe", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": sig }, body: payload });
      return { status: r.status, body: await r.json(), version: r.headers.get("stripe-version") };
    };
    const authReq = (id, amount, merchant) => send("issuing_authorization.request", { id, object: "issuing.authorization", card: "ic_e2e_" + run, amount, currency: "inr", pending_request: { amount, currency: "inr" }, merchant_data: { name: merchant, category: "grocery_stores_supermarkets" } });
    const first = await authReq("iauth_e2e_1_" + run, 100000, "Zepto");
    check("card declines with no prepaid balance", first.status === 200 && first.body.approved === false && first.version, JSON.stringify(first.body));
    const bad = await fetch(BASE + "/api/webhooks/stripe", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=deadbeef" }, body: "{}" });
    check("unsigned webhook rejected", bad.status === 400);
    const topup = await send("checkout.session.completed", { id: "cs_e2e_1_" + run, object: "checkout.session", payment_status: "paid", amount_total: 150000, currency: "inr", client_reference_id: seed.workspace, metadata: { workspaceId: seed.workspace, by: "e2e" } });
    check("top-up credited from checkout webhook", topup.status === 200);
    const dup = await send("checkout.session.completed", { id: "cs_e2e_1_" + run, object: "checkout.session", payment_status: "paid", amount_total: 150000, currency: "inr", client_reference_id: seed.workspace, metadata: { workspaceId: seed.workspace } }, "evt_dup_" + Date.now());
    const second = await authReq("iauth_e2e_2_" + run, 100000, "Zepto");
    const third = await authReq("iauth_e2e_3_" + run, 100000, "Zepto");
    check("card approved once funded, then declined at the balance", dup.status === 200 && second.body.approved === true && third.body.approved === false, `${JSON.stringify(second.body)} ${JSON.stringify(third.body)}`);
    const replay = await authReq("iauth_e2e_2_" + run, 100000, "Zepto");
    check("re-sent authorisation request answers the same", replay.body.approved === true && replay.body.metadata?.replayed === "true");
    await send("issuing_authorization.created", { id: "iauth_e2e_2_" + run, object: "issuing.authorization", card: "ic_e2e_" + run, amount: 100000, approved: false, request_history: [{ reason: "insufficient_funds" }] });
    const fourth = await authReq("iauth_e2e_4_" + run, 100000, "Zepto");
    check("a Stripe-side decline voids the hold and frees the balance", fourth.body.approved === true, JSON.stringify(fourth.body));
    await send("issuing_transaction.created", { id: "ipi_e2e_1_" + run, object: "issuing.transaction", type: "capture", amount: -60000, created: Math.floor(Date.now() / 1000), authorization: "iauth_e2e_4_" + run });
    const fifth = await authReq("iauth_e2e_5_" + run, 60000, "Zepto");
    check("partial capture releases the rest of the hold", fifth.body.approved === true, JSON.stringify(fifth.body));
    await p.goto(BASE + "/mandates/" + home.id, { waitUntil: "networkidle" });
    check("mandate page shows the card and a reveal button", (await p.locator("button", { hasText: "Show card details" }).count()) === 1);
    await p.goto(BASE + "/balance", { waitUntil: "networkidle" });
    check("balance page renders", (await p.locator("h1").textContent())?.includes("available for cards"));
    await p.goto(BASE + "/stats", { waitUntil: "networkidle" });
    await p.click(".seg button:has-text('by merchant')"); await p.click(".seg button:has-text('week')");
    const bars = await p.locator("svg[aria-label='Spend per period'] rect[rx]").count();
    await p.locator("svg[aria-label='Spend per period'] g").last().hover();
    check("stats page charts, switches grain and shows a tooltip", bars > 0 && (await p.locator(".tip").count()) === 1 && (await p.locator(".reading p").count()) >= 3, `bars=${bars}`);
  }

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
  const asm = await fetch(BASE + "/.well-known/oauth-authorization-server/api/auth").then((r) => r.json());
  check("authorization server metadata (issuer path)", asm.issuer === BASE + "/api/auth" && typeof asm.token_endpoint === "string");
  const asmRoot = await fetch(BASE + "/.well-known/oauth-authorization-server").then((r) => r.json());
  check("authorization server metadata (bare root alias)", asmRoot.issuer === asm.issuer && asmRoot.token_endpoint === asm.token_endpoint);

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
