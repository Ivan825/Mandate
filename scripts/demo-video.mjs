// Records the product demo as a narrated video. Drives a real build of the
// app through a real browser while a real agent makes the HTTP calls; each
// scene is held for exactly as long as its narration line, with the same
// words as a caption on screen. A soft synth bed sits under the voice.
//
//   PW_CHROMIUM=... node scripts/demo-video.mjs
//     → public/demo/mandate-demo.mp4 (2560×1440, narrated; served by the site), public/demo/poster.jpg,
//       docs/demo/mandate-demo.gif (720 px wide, silent, for the README)
//
// Needs: a production build (`npm run build`), Postgres at DATABASE_URL,
// Playwright's Chromium, ffmpeg, and Python with kokoro-onnx + soundfile +
// numpy (`pip install kokoro-onnx soundfile numpy`); the ~350 MB voice model
// is fetched once from GitHub into ~/.cache/kokoro-onnx.
import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { chromium } from "playwright";

const PORT = Number(process.env.DEMO_PORT ?? 3170);
const BASE = `http://localhost:${PORT}`;
const PUBLIC = "https://mandate-ashen.vercel.app";
const OUT = "docs/demo";
const WORK = `${OUT}/.work`;
const SITE = "public/demo";
const VOICE = process.env.DEMO_VOICE ?? "af_heart";
const W = 1280, H = 720;      // the page is laid out at 720p…
const SCALE = 2;              // …and recorded at 2× (2560×1440) by zooming the document, since the
                              // screencast captures CSS pixels whatever the device scale factor
let out = "";
const dotenv = existsSync(".env") ? Object.fromEntries(readFileSync(".env", "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^['"]|['"]$/g, "")]; })) : {};
const secret = (k) => process.env[k] ?? dotenv[k];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the script: what is said, and the caption shown while it is said ----
const LINES = [
  ["title", "This is Mandate: scoped, revocable spending authority for AI agents."],
  ["problem", "Agents are starting to buy things. Today that means handing one your card or your API key: all of your money, no limits, no log, no way back."],
  ["owner", "Mandate replaces the card with a mandate. The owner decides how much, where, and when, and the amount above which the agent has to ask."],
  ["terms", "This one: fifty dollars a purchase, a hundred and fifty a day, three merchants, and ask a human above twenty. The token only works inside those terms."],
  ["asks", "Before paying, the agent asks. HTTP, MCP, an SDK, or a proxy key: the same engine every time."],
  ["inscope", "Twelve dollars at OpenAI is in scope: approved, as a hold. The agent captures what it actually spent; the rest goes back."],
  ["offlist", "Fifteen dollars at Namecheap is off the list: declined, with the rule it broke and what to do instead. Nothing left the account."],
  ["pending", "Thirty-five dollars is above the threshold: pending. Nothing moves until a person says yes."],
  ["inbox", "The owner gets a one-tap link, by email, push, or webhook. Larger asks can require two named approvers, or a passkey."],
  ["allowance", "Approved once. The retry goes through, for that amount, at that merchant, consumed on use. Not a standing permission."],
  ["freeze", "And if something looks wrong: freeze all."],
  ["frozen", "One button, every rail: tokens, MCP, proxy keys, cards. Even an approved purchase waits. Nothing is deleted."],
  ["delegate", "An agent can hand a helper a narrower mandate, never a wider one, and the helper's spending counts against the parent."],
  ["revoke", "Revoke the parent,"],
  ["dies", "and the helper dies with it."],
  ["ledger", "Every decision is a row in a hash-chained ledger, signed and anchored publicly once a day. Not even the operator can rewrite it quietly."],
  ["redteam", "Fifty-five adversarial attempts: over its limits, forged links, replayed approvals, tampered vouchers. Fifty-five stopped."],
  ["close", "Mandate is open source. Give your agents a limit, not a card."],
];

const CAPTION = {
  title: null, problem: null,
  owner: `The owner issues a <b>mandate</b>: how much, where, when — and the amount above which the agent must ask.`,
  terms: `<b>$50</b> per purchase · <b>$150</b> a day · OpenAI, Anthropic, Vercel · ask above <b>$20</b>. The token only works inside these terms.`,
  asks: `The agent asks before it pays — HTTP, MCP, SDK or proxy key. Same engine every time.`,
  inscope: `In scope: <b>approved</b> as a hold. The agent captures what it actually spent; the rest goes back.`,
  offlist: `Off the list: <b>declined</b>, with the rule and what to do instead. Nothing left the account.`,
  pending: `Above $20: <b>pending</b>. Nothing moves until a person says yes.`,
  inbox: `One-tap link by email, push or webhook. Large asks can need two named approvers, or a passkey.`,
  allowance: `Approved <b>once</b>: that amount, that merchant, consumed on use.`,
  freeze: `Something looks wrong? <b>Freeze all.</b>`,
  frozen: `One button, every rail. Even an approved purchase waits. Nothing is deleted.`,
  delegate: `A helper gets a <b>narrower</b> mandate — never wider — and its spend counts against the parent.`,
  revoke: `Revoke the parent…`, dies: `…and the helper dies with it.`,
  ledger: `Every decision is in a <b>hash-chained ledger</b>, signed and publicly anchored daily.`,
  redteam: null, close: null,
};

// ---- narration, generated up front so scene lengths are known ----
mkdirSync(`${WORK}/tts`, { recursive: true });
writeFileSync(`${WORK}/lines.json`, JSON.stringify(LINES.map(([id, text]) => ({ id, text }))));
execSync(`python3 -I scripts/demo-tts.py ${WORK}/lines.json ${WORK}/tts ${VOICE} 1.12`, { stdio: ["ignore", "ignore", "inherit"] });
const DUR = JSON.parse(readFileSync(`${WORK}/tts/durations.json`, "utf8"));
const cues = []; // { id, at } — seconds from the start of the recording
let t0 = 0, wallDur = 0;

const app = spawn("npx", ["next", "start", "-p", String(PORT)], { env: {
  ...process.env, ALLOW_SEED: "1", APP_URL: BASE, EMAIL_CONSOLE: "1",
  MANDATE_ENCRYPTION_KEY: secret("MANDATE_ENCRYPTION_KEY") ?? Buffer.alloc(32, 7).toString("base64"),
  RECEIPT_SIGNING_KEY: secret("RECEIPT_SIGNING_KEY") ?? Buffer.alloc(32, 9).toString("base64"),
  NOTIFY_SECRET: secret("NOTIFY_SECRET") ?? Buffer.alloc(32, 5).toString("base64"),
  BETTER_AUTH_SECRET: secret("BETTER_AUTH_SECRET") ?? "demo-secret-0123456789abcdef0123456789abcdef",
}, stdio: ["ignore", "pipe", "pipe"], detached: true });
app.stdout.on("data", (d) => { out += d.toString(); });
app.stderr.on("data", (d) => { out += d.toString(); });
const waitFor = async (url, ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { try { const r = await fetch(url); if (r.ok || r.status === 307) return; } catch {} await sleep(400); } throw new Error("server did not start:\n" + out.slice(-800)); };
const lastLink = (re) => [...out.matchAll(re)].pop()?.[0];

// ---- on-screen text ----
const CSS = `
  .dm-cap { position: fixed; left: 50%; bottom: 40px; transform: translateX(-50%); max-width: 880px; padding: 14px 22px; border-radius: 12px;
    background: rgba(12, 14, 18, 0.92); color: #f3f1ea; font: 500 21px/1.35 -apple-system, "Inter", "Segoe UI", system-ui, sans-serif; letter-spacing: -0.005em;
    box-shadow: 0 10px 40px rgba(0,0,0,.45); border: 1px solid rgba(255,255,255,.08); z-index: 2147483000; opacity: 0; transition: opacity .35s ease; text-align: center; }
  .dm-cap.on { opacity: 1; }
  .dm-cap b { color: #ffb36b; font-weight: 600; }
  .dm-card { position: fixed; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; background: #0b0d11; color: #f3f1ea; z-index: 2147483001;
    font-family: -apple-system, "Inter", "Segoe UI", system-ui, sans-serif; opacity: 0; transition: opacity .5s ease; text-align: center; padding: 0 80px; }
  .dm-card.on { opacity: 1; }
  .dm-card h1 { font-size: 64px; margin: 0; letter-spacing: -0.03em; font-weight: 700; }
  .dm-card h1 .tag { color: #ffb36b; }
  .dm-card p { font-size: 26px; margin: 0; color: #c9c5b8; max-width: 860px; line-height: 1.35; }
  .dm-card .small { font-size: 18px; color: #8d8a80; margin-top: 18px; font-family: ui-monospace, Menlo, monospace; }
  .dm-term { position: fixed; right: 28px; top: 84px; width: 580px; max-height: 580px; overflow: hidden; border-radius: 12px; background: #0e1116; color: #e6e3da; z-index: 2147482999;
    font: 15.5px/1.5 ui-monospace, Menlo, Consolas, monospace; box-shadow: 0 16px 50px rgba(0,0,0,.55); border: 1px solid rgba(255,255,255,.1); opacity: 0; transition: opacity .3s ease; }
  .dm-term.on { opacity: 1; }
  .dm-term .bar { display: flex; gap: 7px; padding: 10px 14px; background: #171b22; border-bottom: 1px solid rgba(255,255,255,.07); }
  .dm-term .bar i { width: 11px; height: 11px; border-radius: 50%; background: #3a3f48; display: block; }
  .dm-term .bar i:nth-child(1) { background: #ff5f57 } .dm-term .bar i:nth-child(2) { background: #febc2e } .dm-term .bar i:nth-child(3) { background: #28c840 }
  .dm-term .bar span { margin-left: auto; color: #8d8a80; font-size: 12.5px; }
  .dm-term pre { margin: 0; padding: 14px 16px; white-space: pre-wrap; word-break: break-word; }
  .dm-term .cmd { color: #c9c5b8 } .dm-term .cmd::before { content: "$ "; color: #5d6470 }
  .dm-term .ok { color: #7ee2a0 } .dm-term .no { color: #ff8a80 } .dm-term .wait { color: #ffd166 } .dm-term .k { color: #9ab8ff }
`;
async function ensureStyles(p) { await p.evaluate(([css, z]) => { if (!document.getElementById("dm-zoom")) { const st = document.createElement("style"); st.id = "dm-zoom"; st.textContent = `html{zoom:${z}}`; document.head.appendChild(st); } if (!document.getElementById("dm-style")) { const s = document.createElement("style"); s.id = "dm-style"; s.textContent = css; document.head.appendChild(s); } }, [CSS, SCALE]); }
async function showCaption(p, html) { await ensureStyles(p); await p.evaluate((html) => { document.querySelectorAll(".dm-cap").forEach((e) => e.remove()); const d = document.createElement("div"); d.className = "dm-cap"; d.innerHTML = html; document.body.appendChild(d); requestAnimationFrame(() => d.classList.add("on")); }, html); }
async function clearCaption(p) { await p.evaluate(() => document.querySelectorAll(".dm-cap").forEach((e) => { e.classList.remove("on"); setTimeout(() => e.remove(), 400); })); await sleep(420); }
async function showCard(p, title, sub, small) { await ensureStyles(p); await p.evaluate(([title, sub, small]) => { const d = document.createElement("div"); d.className = "dm-card"; d.innerHTML = `<h1>${title}</h1><p>${sub}</p>${small ? `<div class="small">${small}</div>` : ""}`; document.body.appendChild(d); requestAnimationFrame(() => d.classList.add("on")); }, [title, sub, small]); }
async function hideCard(p) { await p.evaluate(() => document.querySelectorAll(".dm-card").forEach((e) => { e.classList.remove("on"); setTimeout(() => e.remove(), 520); })); await sleep(540); }
async function term(p, title, cmdText, status, body, { typeMs = 12 } = {}) {
  await ensureStyles(p);
  await p.evaluate(([title]) => { document.querySelectorAll(".dm-term").forEach((e) => e.remove()); const d = document.createElement("div"); d.className = "dm-term"; d.innerHTML = `<div class="bar"><i></i><i></i><i></i><span>${title}</span></div><pre><div class="cmd"></div><div class="res"></div></pre>`; document.body.appendChild(d); requestAnimationFrame(() => d.classList.add("on")); }, [title]);
  for (let i = 3; i <= cmdText.length; i += 3) { await p.evaluate((t) => { document.querySelector(".dm-term .cmd").textContent = t; }, cmdText.slice(0, i)); if (typeMs) await sleep(typeMs); }
  await p.evaluate((t) => { document.querySelector(".dm-term .cmd").textContent = t; }, cmdText);
  await sleep(350);
  const cls = status >= 400 ? "no" : status === 202 ? "wait" : "ok";
  const pretty = JSON.stringify(body, null, 2).replace(/"([^"]+)":/g, '<span class="k">"$1"</span>:');
  await p.evaluate(([s, cls, pretty]) => { document.querySelector(".dm-term .res").innerHTML = `\n<span class="${cls}">HTTP ${s}</span>\n${pretty}`; }, [String(status), cls, pretty]);
}
async function clearTerm(p) { await p.evaluate(() => document.querySelectorAll(".dm-term").forEach((e) => { e.classList.remove("on"); setTimeout(() => e.remove(), 320); })); await sleep(340); }
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

// Speak a line: show its caption, note when it started, hold until it ends.
async function say(p, id, { caption = CAPTION[id], tail = 350 } = {}) {
  if (caption) await showCaption(p, caption);
  cues.push({ id, at: (Date.now() - t0) / 1000 });
  await sleep(DUR[id] * 1000 + tail);
}

// ---- the agent, over HTTP ----
function agent(token) {
  const h = { authorization: "Bearer " + token, "content-type": "application/json" };
  const call = async (method, path, body) => { const r = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch {} return { status: r.status, body: j ?? {} }; };
  return { authorize: (b) => call("POST", "/api/agent/authorize", b), capture: (b) => call("POST", "/api/agent/capture", b), delegate: (b) => call("POST", "/api/agent/delegate", b) };
}
const curl = (path, body, tok = "$MANDATE_TOKEN") => `curl -s ${PUBLIC}${path} \\\n  -H "Authorization: Bearer ${tok}" \\\n  -d '${JSON.stringify(body)}'`;

mkdirSync(`${WORK}/video`, { recursive: true }); mkdirSync(SITE, { recursive: true });
try {
  await waitFor(BASE + "/");
  const b = await chromium.launch({ executablePath: process.env.PW_CHROMIUM });

  // Setup (not recorded): sign in, seed, an email channel so one-tap links exist, a clean mandate from the real form.
  const setup = await b.newContext({ viewport: { width: W, height: H } });
  await setup.addCookies([{ name: "theme", value: "dark", url: BASE }]);
  const s = await setup.newPage();
  const email = `demo-${Date.now()}@example.com`;
  await s.goto(BASE + "/sign-in", { waitUntil: "load" });
  await s.fill("#email", email); await s.click("form.form button[type=submit]");
  await s.waitForSelector(".notice.ok"); await sleep(800);
  const link = lastLink(new RegExp(`${BASE}/api/auth/magic-link/verify\\?[^\\s]+`, "g"));
  if (!link) throw new Error("no sign-in link");
  await s.goto(link, { waitUntil: "load" });
  const seed = await s.evaluate(() => fetch("/api/dev/seed", { method: "POST" }).then((r) => r.json()));
  if (!seed.seeded) throw new Error("seed failed " + JSON.stringify(seed).slice(0, 200));
  await s.goto(BASE + "/settings", { waitUntil: "load" });
  await s.selectOption("select[name=type]", "email"); await s.fill("input[name=target]", email);
  await Promise.all([s.waitForURL(/settings\?(error|channel)=/), s.locator("form", { has: s.locator("select[name=type]") }).locator("button[type=submit]").click()]);
  await s.goto(BASE + "/mandates/new?template=llm-dev", { waitUntil: "load" });
  await s.fill("#name", "Research assistant"); await s.fill("#perTxnLimit", "50"); await s.fill("#dailyLimit", "150"); await s.fill("#totalLimit", "600"); await s.fill("#approvalAbove", "20"); await s.fill("#vetoAbove", ""); await s.fill("#allowedMerchants", "OpenAI, Anthropic, Vercel*");
  await Promise.all([s.waitForURL(/\/mandates\/[0-9a-f-]+\?new=1/), s.locator("form.form button.accent[type=submit]").click()]);
  const token = (await s.locator(".token").textContent())?.trim();
  const mandateId = s.url().match(/\/mandates\/([0-9a-f-]+)/)[1];
  const A = agent(token);
  const cookies = await setup.cookies();
  await setup.close();

  // Recorded context.
  const ctx = await b.newContext({ viewport: { width: W * SCALE, height: H * SCALE }, deviceScaleFactor: 1, recordVideo: { dir: `${WORK}/video`, size: { width: W * SCALE, height: H * SCALE } } });
  // A <style> rule rather than an inline style: React re-renders the <html> element's attributes on hydration and would wipe an inline zoom.
  await ctx.addInitScript(([z, w]) => { const apply = () => { if (!document.head) return; if (!document.getElementById("dm-zoom")) { const st = document.createElement("style"); st.id = "dm-zoom"; st.textContent = `html{zoom:${z}}`; document.head.appendChild(st); } }; apply(); new MutationObserver(apply).observe(document, { childList: true, subtree: true }); document.addEventListener("DOMContentLoaded", apply); /* A root zoom set from a stylesheet is not always applied to the first paint; inserting a (hidden) element nudges Chromium into a fresh layout, and the poll covers hydration re-renders. */ const iv = setInterval(() => { apply(); if (document.body && !document.getElementById("dm-kick")) { const k = document.createElement("div"); k.id = "dm-kick"; k.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;pointer-events:none;visibility:hidden"; document.body.appendChild(k); } }, 40); setTimeout(() => clearInterval(iv), 15000); }, [SCALE, W]);
  await ctx.addCookies(cookies);
  await ctx.route((u) => !u.href.startsWith(BASE), (route) => route.abort());
  const p = await ctx.newPage();
  t0 = Date.now();

  // 1. Open
  await p.goto(BASE + "/", { waitUntil: "load" });
  await showCard(p, `Mandate`, `Scoped, revocable spending authority for AI agents.`, "");
  await say(p, "title", { tail: 700 }); await hideCard(p);
  await showCard(p, `Give an agent a <span class="tag">limit</span>, not a card.`, `Today, letting an agent buy things means handing it your card or your API key — all of your money, no log, no way back.`, "");
  await say(p, "problem", { tail: 600 }); await hideCard(p);

  // 2. The owner's side
  await p.goto(BASE + "/", { waitUntil: "load" });
  await say(p, "owner"); await clearCaption(p);
  await p.goto(BASE + "/mandates/" + mandateId, { waitUntil: "load" });
  await say(p, "terms"); await clearCaption(p);

  // 3. The agent asks
  await say(p, "asks");
  let r = await A.authorize({ amount: 1200, merchant: "OpenAI", purpose: "API credits" });
  await term(p, "agent", curl("/api/agent/authorize", { amount: 1200, merchant: "OpenAI", purpose: "API credits" }), r.status, pick(r.body, ["decision", "rule", "reason", "settlement", "holdExpiresAt"]));
  await say(p, "inscope");
  await A.capture({ transactionId: r.body.transactionId, amount: 1100 });
  r = await A.authorize({ amount: 1500, merchant: "Namecheap", purpose: "a domain" });
  await term(p, "agent", curl("/api/agent/authorize", { amount: 1500, merchant: "Namecheap", purpose: "a domain" }), r.status, pick(r.body, ["decision", "rule", "reason", "remedy"]));
  await say(p, "offlist");
  const ask = await A.authorize({ amount: 3500, merchant: "Anthropic", purpose: "Claude credits for the week" });
  await term(p, "agent", curl("/api/agent/authorize", { amount: 3500, merchant: "Anthropic", purpose: "Claude credits for the week" }), ask.status, pick(ask.body, ["decision", "rule", "reason", "approvalId", "remedy"]));
  await say(p, "pending");
  await clearTerm(p); await clearCaption(p);

  // 4. The human says yes
  await p.goto(BASE + "/approvals", { waitUntil: "networkidle" });
  const cardEl = p.locator(".approval", { hasText: "Claude credits for the week" }).first();
  await cardEl.waitFor(); await sleep(400);
  for (let i = 0; i < 3; i++) { try { await cardEl.scrollIntoViewIfNeeded(); break; } catch { await sleep(400); } }
  const inboxSay = say(p, "inbox", { tail: 200 });
  await sleep(Math.max(0, DUR.inbox * 1000 - 1400));
  await cardEl.getByRole("button", { name: "Approve once", exact: true }).hover();
  await inboxSay;
  await Promise.all([p.waitForURL(/\/approvals/), cardEl.getByRole("button", { name: "Approve once", exact: true }).click()]);
  await sleep(900);
  await clearCaption(p);
  r = await A.authorize({ amount: 3500, merchant: "Anthropic", purpose: "Claude credits for the week" });
  await term(p, "agent — retry", curl("/api/agent/authorize", { amount: 3500, merchant: "Anthropic", purpose: "Claude credits for the week" }), r.status, pick(r.body, ["decision", "rule", "reason", "settlement"]));
  await say(p, "allowance");
  await clearTerm(p); await clearCaption(p);

  // 5. Panic
  await p.goto(BASE + "/", { waitUntil: "load" });
  const freezeSay = say(p, "freeze", { tail: 300 });
  await sleep(Math.max(0, DUR.freeze * 1000 - 900));
  await p.locator("details.panic > summary").click(); await sleep(500);
  await freezeSay;
  await p.fill("#panic-reason", "agent is looping"); await sleep(400);
  await p.locator("details.panic button[type=submit]").click();
  await p.waitForSelector(".notice.frozen", { timeout: 20000 }); await sleep(700);
  r = await A.authorize({ amount: 500, merchant: "OpenAI", purpose: "more credits" });
  await term(p, "agent", curl("/api/agent/authorize", { amount: 500, merchant: "OpenAI", purpose: "more credits" }), r.status, pick(r.body, ["decision", "rule", "reason"]));
  await say(p, "frozen");
  await clearTerm(p); await clearCaption(p);
  await p.locator(".notice.frozen button", { hasText: "Unfreeze" }).click();
  await p.waitForSelector(".notice.frozen", { state: "detached", timeout: 20000 }); await sleep(500);

  // 6. Delegation
  await p.goto(BASE + "/mandates/" + mandateId, { waitUntil: "load" });
  const child = await A.delegate({ name: "Price checker", perTxnLimit: 1000, dailyLimit: 2000, totalLimit: 4000, approvalAbove: 800, allowedMerchants: ["OpenAI"], agentName: "helper" });
  await term(p, "agent", curl("/api/agent/delegate", { name: "Price checker", perTxnLimit: 1000, dailyLimit: 2000, totalLimit: 4000, approvalAbove: 800, allowedMerchants: ["OpenAI"] }), child.status, { ...pick(child.body, ["mandateId", "limits"]), token: "mnd_…(returned once)" });
  await say(p, "delegate");
  await clearTerm(p);
  const K = agent(child.body.token);
  await p.reload({ waitUntil: "networkidle" }); await sleep(400);
  for (let i = 0; i < 3; i++) { try { await p.locator("h2", { hasText: "Sub-mandates" }).scrollIntoViewIfNeeded(); break; } catch { await sleep(400); } }
  await sleep(900);
  for (let i = 0; i < 3; i++) { try { await p.locator("button", { hasText: "Revoke now" }).first().scrollIntoViewIfNeeded(); break; } catch { await sleep(400); } }
  const revokeSay = say(p, "revoke", { tail: 100 });
  await sleep(Math.max(0, DUR.revoke * 1000 - 500));
  await Promise.all([p.waitForURL(/\/mandates\//), p.locator("button", { hasText: "Revoke now" }).first().click()]);
  await revokeSay;
  await sleep(600);
  r = await K.authorize({ amount: 500, merchant: "OpenAI", purpose: "price check" });
  await term(p, "helper", curl("/api/agent/authorize", { amount: 500, merchant: "OpenAI", purpose: "price check" }, "$HELPER_TOKEN"), r.status, pick(r.body, ["decision", "rule", "reason", "error"]));
  await say(p, "dies", { tail: 900 });
  await clearTerm(p); await clearCaption(p);

  // 7. The record
  await p.goto(BASE + "/ledger", { waitUntil: "load" });
  await say(p, "ledger"); await clearCaption(p);

  // 8. Close
  await showCard(p, `<span class="tag">55</span> adversarial attempts. <span class="tag">55</span> stopped.`, `Over its limits, off its list, forged links, replayed approvals, widened delegations, tampered vouchers — none of them moved money. Re-run it yourself: <code>npm run redteam</code>.`, "");
  await say(p, "redteam", { tail: 700 }); await hideCard(p);
  await showCard(p, `Mandate`, `Open source · AGPL-3.0 · works with Claude (MCP), OpenAI/Anthropic/Gemini SDKs, any REST client.`, "github.com/Ivan825/Mandate");
  await say(p, "close", { tail: 2600 });
  wallDur = (Date.now() - t0) / 1000;

  await ctx.close();
  await b.close();
} catch (e) {
  console.error("demo failed:", e?.stack ?? e); console.error(out.slice(-1200));
  process.exitCode = 1;
} finally {
  try { process.kill(-app.pid, "SIGTERM"); } catch { app.kill("SIGTERM"); }
}

// ---- sound and encode ----
if (!process.exitCode) {
  const webm = readdirSync(`${WORK}/video`).filter((f) => f.endsWith(".webm")).map((f) => `${WORK}/video/${f}`).sort()[0];
  if (!webm) { console.error("no video was recorded"); process.exit(1); }
  const silent = `${WORK}/silent.mp4`;
  execSync(`ffmpeg -y -loglevel error -i ${webm} -c:v libx264 -preset slow -crf 22 -pix_fmt yuv420p -r 30 -an ${silent}`, { stdio: "inherit" });
  const dur = Number(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 ${silent}`).toString().trim());
  // The recorder's clock runs a little slower than wall time; scale the cue
  // times by the ratio so the voice lands on the frames it describes.
  const stretch = wallDur ? dur / wallDur : 1;
  for (const c of cues) c.at *= stretch;
  console.log(`recorded ${wallDur.toFixed(1)}s of wall time as ${dur.toFixed(1)}s of video (×${stretch.toFixed(3)})`);
  // Music bed as long as the picture, softened; narration placed at its cue times; the bed ducks under the voice.
  execSync(`python3 -I scripts/demo-music.py ${Math.ceil(dur + 1)} ${WORK}/music.wav`, { stdio: ["ignore", "ignore", "inherit"] });
  const inputs = cues.map((c) => `-i ${WORK}/tts/${c.id}.wav`).join(" ");
  const delays = cues.map((c, i) => `[${i + 2}:a]aresample=44100,aformat=channel_layouts=stereo,adelay=${Math.round(c.at * 1000)}|${Math.round(c.at * 1000)}[v${i}]`).join(";");
  const voiceMix = cues.map((_, i) => `[v${i}]`).join("") + `amix=inputs=${cues.length}:normalize=0,volume=1.0[voice]`;
  const filter = `${delays};${voiceMix};[1:a]lowpass=f=1600,lowpass=f=1600,aecho=0.7:0.5:60|110:0.18|0.12,volume=0.55[bed];[voice]asplit[vA][vB];[bed][vA]sidechaincompress=threshold=0.02:ratio=6:attack=40:release=600:makeup=1[ducked];[ducked][vB]amix=inputs=2:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[a]`;
  execSync(`ffmpeg -y -loglevel error -i ${silent} -i ${WORK}/music.wav ${inputs} -filter_complex "${filter}" -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 160k -shortest -movflags +faststart ${SITE}/mandate-demo.mp4`, { stdio: "inherit" });
  execSync(`ffmpeg -y -loglevel error -i ${silent} -vf "fps=8,scale=640:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=96:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" ${OUT}/mandate-demo.gif`, { stdio: "inherit" });
  // Poster: the terms scene, a few seconds into its line.
  const poster = cues.find((c) => c.id === "terms");
  execSync(`ffmpeg -y -loglevel error -ss ${(poster.at + 2).toFixed(2)} -i ${silent} -frames:v 1 -q:v 3 ${SITE}/poster.jpg`, { stdio: "inherit" });
  writeFileSync(`${WORK}/cues.json`, JSON.stringify(cues, null, 1));
  console.log(`wrote ${SITE}/mandate-demo.mp4 (${W * SCALE}×${H * SCALE}, ${dur.toFixed(0)}s, narrated by ${VOICE}), ${SITE}/poster.jpg and ${OUT}/mandate-demo.gif`);
}
process.exit(process.exitCode ?? 0);
