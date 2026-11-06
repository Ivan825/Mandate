// Red-team harness: an adversarial agent against a running Mandate.
//
//   npm run redteam            (spawns `next start` on :3200 against DATABASE_URL, like the e2e suite)
//   REDTEAM_WRITE=1 npm run redteam   also rewrites docs/RED-TEAM.md with the results
//
// Every scenario is something a misbehaving or compromised agent could try —
// over its limits, off its merchant list, replaying an approval, forging a
// link, widening a delegation, settling someone else's hold, tampering with
// a voucher — and the check is the same each time: did money (an approved,
// capturable authorisation) come out when it should not have?
//
// The owner's side (sign-in, seeding, freezing, revoking) is driven through a
// real browser because those are deliberately not API calls; the attacker's
// side is plain HTTP, exactly as an agent would make it.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { chromium } from "playwright";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const PORT = Number(process.env.REDTEAM_PORT ?? 3200);
const BASE = `http://localhost:${PORT}`;
const results = [];
let out = "";

const app = spawn("npx", ["next", "start", "-p", String(PORT)], { env: {
  ...process.env, ALLOW_SEED: "1", APP_URL: BASE, EMAIL_CONSOLE: "1", CRON_SECRET: "redteam-cron-secret-0123456789",
  MANDATE_ENCRYPTION_KEY: process.env.MANDATE_ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString("base64"),
  RECEIPT_SIGNING_KEY: process.env.RECEIPT_SIGNING_KEY ?? Buffer.alloc(32, 9).toString("base64"),
  ...(() => { const { generateVAPIDKeys } = require("web-push"); const k = generateVAPIDKeys(); return { VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey, VAPID_SUBJECT: "mailto:redteam@example.com" }; })(),
}, stdio: ["ignore", "pipe", "pipe"], detached: true });
app.stdout.on("data", (d) => { out += d.toString(); });
app.stderr.on("data", (d) => { out += d.toString(); });
const waitFor = async (url, ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { try { const r = await fetch(url); if (r.ok || r.status === 307) return; } catch {} await new Promise((r) => setTimeout(r, 500)); } throw new Error("server did not start:\n" + out.slice(-800)); };
const lastLink = (re) => [...out.matchAll(re)].pop()?.[0];
const waitLink = async (re, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { const l = lastLink(re); if (l) return l; await sleep(200); } throw new Error("expected a link in the server output: " + re); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the attacker's toolkit: plain HTTP with a mandate token ----
function agent(token) {
  const h = { authorization: "Bearer " + token, "content-type": "application/json" };
  const call = async (method, path, body, extra = {}) => {
    const r = await fetch(BASE + path, { method, headers: { ...h, ...extra }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    let json = null; try { json = await r.json(); } catch {}
    return { status: r.status, body: json ?? {}, headers: r.headers };
  };
  return {
    authorize: (b, extra) => call("POST", "/api/agent/authorize", b, extra),
    capture: (b) => call("POST", "/api/agent/capture", b),
    void: (b) => call("POST", "/api/agent/void", b),
    delegate: (b) => call("POST", "/api/agent/delegate", b),
    mandate: () => call("GET", "/api/agent/mandate"),
    tx: (id) => call("GET", `/api/agent/transactions/${id}`),
    voucher: (id) => call("GET", `/api/agent/transactions/${id}/voucher`),
  };
}
const anon = async (method, path, body) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); let json = null; try { json = await r.json(); } catch {} return { status: r.status, body: json ?? {} }; };

// A scenario passes when the agent did NOT get what it was after.
// `moved` says whether an approval that could be captured came out of it.
function record(group, title, attempt, expect, got, pass) { results.push({ group, title, attempt, expect, got, pass }); console.log(`${pass ? "ok  " : "FAIL"} [${group}] ${title} — ${got}`); }
const declined = (r, rule) => r.status === 403 && r.body.decision === "declined" && (!rule || r.body.rule === rule);
const pending = (r) => r.status === 202 && r.body.decision === "pending";
const approved = (r) => r.status === 200 && r.body.decision === "approved";
const summarise = (r) => { const detail = r.body.errors?.[0]?.message ?? r.body.error; return `${r.status} ${r.body.decision ?? ""}${r.body.rule ? "/" + r.body.rule : ""}${detail ? " " + String(detail).slice(0, 80) : ""}`.trim(); };

try {
  await waitFor(BASE + "/");
  const b = await chromium.launch({ executablePath: process.env.PW_CHROMIUM });
  const p = await (await b.newContext()).newPage();

  // ---- owner: sign in, seed, issue the mandates the attacker will hold ----
  const email = `redteam-${Date.now()}@example.com`;
  await p.goto(BASE + "/sign-in", { waitUntil: "networkidle" });
  await p.fill("#email", email); await p.click("form.form button[type=submit]");
  await p.waitForSelector(".notice.ok"); await sleep(800);
  const link = lastLink(new RegExp(`${BASE}/api/auth/magic-link/verify\\?[^\\s]+`, "g"));
  if (!link) throw new Error("no sign-in link in server output");
  await p.goto(link, { waitUntil: "networkidle" });
  const seed = await p.evaluate(async () => (await fetch("/api/dev/seed", { method: "POST" })).json());
  if (!seed.seeded) throw new Error("seed failed: " + JSON.stringify(seed));
  // Approval links arrive by email; the owner needs an email channel (printed to the console here).
  await p.goto(BASE + "/settings", { waitUntil: "networkidle" });
  await p.selectOption("select[name=type]", "email"); await p.fill("input[name=target]", email);
  await Promise.all([p.waitForURL(/settings\?(error|channel)=/), p.locator("form", { has: p.locator("select[name=type]") }).locator("button[type=submit]").click()]);
  if (!p.url().includes("channel=added")) throw new Error("could not add the owner's email channel: " + p.url());

  // The attacker's main mandate: $50/txn, $150/day, $300 total, ask above $20,
  // OpenAI and Anthropic only, 24h. Issued from the real form, as an owner would.
  async function issue(fields) {
    await p.goto(BASE + "/mandates/new?template=llm-dev", { waitUntil: "networkidle" });
    for (const [id, v] of Object.entries(fields)) { if (v === true) await p.check(`input[name=${id}]`); else if (typeof v === "string" && (await p.locator(`select#${id}`).count())) await p.selectOption(`#${id}`, v); else await p.fill(`#${id}`, String(v)); }
    await Promise.all([p.waitForURL(/\/mandates\/[0-9a-f-]+\?new=1/), p.locator("form.form button.accent[type=submit]").click()]);
    const token = (await p.locator(".token").textContent())?.trim();
    const id = p.url().match(/\/mandates\/([0-9a-f-]+)/)[1];
    return { token, id };
  }
  const main = await issue({ name: "Red team — main", perTxnLimit: "50", dailyLimit: "150", totalLimit: "300", approvalAbove: "20", vetoAbove: "", allowedMerchants: "OpenAI, Anthropic", blockedCategories: "gambling, crypto" });
  const A = agent(main.token);
  // A second, unrelated mandate: the attacker should never be able to touch its rows.
  const other = await issue({ name: "Red team — someone else", perTxnLimit: "50", dailyLimit: "150", totalLimit: "300", approvalAbove: "", vetoAbove: "", allowedMerchants: "" });
  const O = agent(other.token);
  // A mandate whose hours exclude right now (a one-hour window that ended two hours ago, in UTC).
  const nowH = new Date().getUTCHours();
  const hours = await issue({ name: "Red team — office hours", perTxnLimit: "50", dailyLimit: "150", totalLimit: "300", approvalAbove: "", vetoAbove: "", allowedMerchants: "", timezone: "UTC", activeHoursStart: String((nowH + 21) % 24), activeHoursEnd: String((nowH + 22) % 24) });
  const H = agent(hours.token);
  // A mandate whose big asks need two named approvers.
  const cosign = await issue({ name: "Red team — co-sign", perTxnLimit: "100", dailyLimit: "300", totalLimit: "900", approvalAbove: "40", vetoAbove: "", allowedMerchants: "", cosignOn: true, cosignAbove: "60", cosignCount: "2" });
  const C = agent(cosign.token);

  // ================= 1. Limits and scope =================
  let r;
  r = await A.authorize({ amount: 5001, merchant: "OpenAI" });
  record("limits", "Spend one cent above the per-transaction limit", "amount 5001 vs limit 5000", "declined per_txn", summarise(r), declined(r, "per_txn"));
  r = await A.authorize({ amount: 100, merchant: "Namecheap" });
  record("scope", "Buy from a merchant not on the list", "Namecheap; allowed OpenAI, Anthropic", "declined merchant", summarise(r), declined(r, "merchant"));
  r = await A.authorize({ amount: 100, merchant: "OpenAI Marketplace Reseller" });
  record("scope", "Pad an allowed merchant's name (prefix attack)", "\"OpenAI Marketplace Reseller\" vs exact \"OpenAI\"", "declined merchant", summarise(r), declined(r, "merchant"));
  r = await A.authorize({ amount: 100, merchant: "openai" });
  record("scope", "Case-only variant of an allowed merchant", "\"openai\" — case is not a loophole either way", "approved (same merchant)", summarise(r), approved(r));
  if (approved(r)) await A.void({ transactionId: r.body.transactionId });
  r = await A.authorize({ amount: 100, merchant: "OpenAI", category: "crypto" });
  record("scope", "Declare a blocked category", "category crypto", "declined category", summarise(r), declined(r, "category"));
  r = await H.authorize({ amount: 100, merchant: "OpenAI" });
  record("scope", "Spend outside the mandate's active hours", "window closed two hours ago (UTC)", "declined hours + retryAt", summarise(r), declined(r, "hours") && typeof r.body.remedy?.retryAt === "string");
  for (const [label, amount] of [["zero", 0], ["negative", -500], ["fractional", 12.5], ["string", "1e3"], ["huge", 2 ** 40], ["NaN", "abc"]]) {
    r = await A.authorize({ amount, merchant: "OpenAI" });
    record("input", `Malformed amount: ${label}`, JSON.stringify(amount), "400 refused", summarise(r), r.status === 400);
  }
  r = await A.authorize("{\"amount\": 100, \"amount\": 999999, \"merchant\": \"OpenAI\"}");
  record("input", "Duplicate JSON keys (last one wins in JS)", "amount 100 then 999999", "declined per_txn — the parsed value is the priced value", summarise(r), declined(r, "per_txn"));
  r = await A.authorize({ amount: 100, merchant: "OpenAI", currency: "INR" });
  record("input", "Claim a cheaper currency than the mandate's", "currency INR on a USD mandate", "ignored or refused; never re-priced", summarise(r), r.status === 400 || (approved(r) && r.body.remaining?.currency === "USD"));
  if (approved(r)) await A.void({ transactionId: r.body.transactionId });

  // Daily limit by many small purchases: 1500 cents left of 15000? No — this mandate is $150/day = 15000c; spend in 4000c steps.
  const dayLog = [];
  for (let i = 0; i < 9; i++) { r = await A.authorize({ amount: 1900, merchant: "OpenAI", purpose: `slice ${i}` }); dayLog.push(r); }
  const approvedSlices = dayLog.filter(approved).length, dailyDeclines = dayLog.filter((x) => declined(x, "daily")).length;
  record("limits", "Salami-slice under the per-transaction limit until the day is exhausted", "9 × $19.00 against $150/day", `7 approved (= $133), then declined daily`, `${approvedSlices} approved, ${dailyDeclines} declined daily`, approvedSlices + dailyDeclines === 9 && dailyDeclines >= 1 && approvedSlices * 1900 <= 15000);
  for (const x of dayLog) if (approved(x)) await A.void({ transactionId: x.body.transactionId }); // give the day back

  // ================= 2. Escalation to a human =================
  const ask = await A.authorize({ amount: 3500, merchant: "Anthropic", purpose: "needs a human" });
  record("approval", "Spend above the ask-me threshold", "$35.00 vs ask above $20.00", "202 pending, nothing capturable", summarise(ask), pending(ask) && ask.body.settlement == null);
  r = await A.authorize({ amount: 3500, merchant: "Anthropic", purpose: "needs a human" });
  record("approval", "Hammer the same request while it is pending", "identical retry", "still pending, no second approval row", summarise(r), pending(r) && r.body.approvalId === ask.body.approvalId);
  r = await A.capture({ transactionId: ask.body.transactionId, amount: 3500 });
  record("approval", "Capture the pending request as if it were approved", "capture on a pending transaction", "409/404, nothing moves", summarise(r), r.status === 409 || r.status === 404);
  const approveLink = await waitLink(new RegExp(`${BASE}/a/${ask.body.approvalId}\\?d=approve&t=[^\\s]+`, "g"));
  const forged = approveLink.replace(/&t=[^&]+$/, "&t=" + Math.floor(Date.now() / 1000 + 3600) + ".u" + Buffer.from("attacker").toString("base64url") + ".deadbeefdeadbeef");
  r = await anon("POST", forged.replace(BASE, "").replace("/a/", "/api/approvals/onetap/"));
  record("approval", "Forge the one-tap approve link", "valid id, invented signature", "403", String(r.status), r.status === 403);
  r = await anon("POST", approveLink.replace(BASE, "").replace("/a/", "/api/approvals/onetap/").replace("d=approve", "d=deny"));
  record("approval", "Reuse an approve link's token to deny instead", "decision swapped under the same signature", "403", String(r.status), r.status === 403);
  const otherAsk = await O.authorize({ amount: 3500, merchant: "Anything" }); // other mandate has no ask threshold → approved; make a pending one on cosign instead
  if (approved(otherAsk)) await O.void({ transactionId: otherAsk.body.transactionId });
  r = await anon("POST", approveLink.replace(BASE, "").replace("/a/", "/api/approvals/onetap/"));
  record("approval", "Legitimate owner taps approve (control)", "the real signed link", "200 approved", String(r.status), r.status === 200);
  r = await anon("POST", approveLink.replace(BASE, "").replace("/a/", "/api/approvals/onetap/"));
  record("approval", "Replay the same approve link", "second tap", "409 already decided", String(r.status), r.status === 409);
  r = await A.authorize({ amount: 3600, merchant: "Anthropic", purpose: "needs a human" });
  record("approval", "Use the allowance for a different amount", "$36.00 against an allowance for $35.00", "pending again, not approved", summarise(r), pending(r));
  r = await A.authorize({ amount: 3500, merchant: "OpenAI", purpose: "needs a human" });
  record("approval", "Use the allowance at a different merchant", "OpenAI against an allowance for Anthropic", "pending again, not approved", summarise(r), pending(r));
  const granted = await A.authorize({ amount: 3500, merchant: "Anthropic", purpose: "needs a human" });
  record("approval", "Retry the exact approved request (control)", "$35.00 at Anthropic", "approved by allowance", summarise(granted), approved(granted) && granted.body.rule === "allowance");
  r = await A.authorize({ amount: 3500, merchant: "Anthropic", purpose: "needs a human" });
  record("approval", "Spend the same allowance twice", "identical request after it was consumed", "pending, not approved", summarise(r), pending(r));
  const denyLink = await waitLink(new RegExp(`${BASE}/a/${r.body.approvalId}\\?d=deny&t=[^\\s]+`, "g"));
  await anon("POST", denyLink.replace(BASE, "").replace("/a/", "/api/approvals/onetap/"));
  r = await A.authorize({ amount: 3500, merchant: "Anthropic", purpose: "needs a human" });
  record("approval", "Re-ask immediately after a denial", "same ask, seconds later", "declined denied_recently", summarise(r), declined(r, "denied_recently"));
  const big = await C.authorize({ amount: 7000, merchant: "OpenAI", purpose: "two signatures" });
  const bigLink = await waitLink(new RegExp(`${BASE}/a/${big.body.approvalId}\\?d=approve&t=[^\\s]+`, "g"));
  r = await anon("POST", bigLink.replace(BASE, "").replace("/a/", "/api/approvals/onetap/"));
  const stillPending = await C.authorize({ amount: 7000, merchant: "OpenAI", purpose: "two signatures" });
  record("approval", "Approve a two-signature request with a single person's tap", "one owner taps the link on a co-sign request", "counts as one signature; request stays pending", `${r.status} cosigned=${r.body.cosigned} then ${summarise(stillPending)}`, r.status === 200 && r.body.cosigned === true && pending(stillPending));
  r = await anon("POST", bigLink.replace(BASE, "").replace("/a/", "/api/approvals/onetap/"));
  record("approval", "The same person taps the co-sign link again", "second tap by the same signer", "not a second signature; still pending", `${r.status} ${JSON.stringify(r.body).slice(0, 60)}`, (r.status === 200 || r.status === 409) && pending(await C.authorize({ amount: 7000, merchant: "OpenAI", purpose: "two signatures" })));

  // ================= 3. Holds, settlement, vouchers =================
  const hold = granted;
  r = await A.capture({ transactionId: hold.body.transactionId, amount: 3501 });
  record("settlement", "Capture more than was authorised", "3501 against a 3500 hold", "400/409 bad amount", summarise(r), r.status === 400 || r.status === 409);
  r = await O.void({ transactionId: hold.body.transactionId });
  record("settlement", "Another mandate's token voids this hold", "cross-mandate void", "404 — the row is invisible", String(r.status), r.status === 404);
  r = await O.tx(hold.body.transactionId);
  record("settlement", "Another mandate's token reads this transaction", "cross-mandate read", "404", String(r.status), r.status === 404);
  const v = await A.voucher(hold.body.transactionId);
  record("settlement", "Fetch the voucher for the hold (control)", "GET …/voucher", "200 mv1.…", String(v.status), v.status === 200 && String(v.body.voucher).startsWith("mv1."));
  r = await A.capture({ transactionId: hold.body.transactionId, amount: 1 });
  record("settlement", "Capture the hold after handing its voucher to a merchant", "capture with a voucher outstanding", "409", String(r.status), r.status === 409);
  r = await A.void({ transactionId: hold.body.transactionId });
  record("settlement", "Void the hold after handing its voucher to a merchant", "void with a voucher outstanding", "409", String(r.status), r.status === 409);
  const [vt, vp, vs] = String(v.body.voucher).split(".");
  const tampered = `${vt}.${Buffer.from(Buffer.from(vp, "base64url").toString().replace('"amount":3500', '"amount":9500')).toString("base64url")}.${vs}`;
  r = await anon("POST", "/api/vouchers/verify", { voucher: tampered });
  record("voucher", "Raise the amount inside the voucher", "payload edited, signature kept", "invalid", JSON.stringify(r.body).slice(0, 60), r.body.valid === false);
  r = await anon("POST", "/api/vouchers/redeem", { voucher: v.body.voucher, amount: 3600, merchant: "Anthropic" });
  record("voucher", "Merchant redeems for more than authorised", "3600 against 3500", "refused", String(r.status), r.status >= 400);
  r = await anon("POST", "/api/vouchers/redeem", { voucher: v.body.voucher, amount: 3000, merchant: "SomeoneElse" });
  record("voucher", "A different merchant redeems the voucher", "merchant mismatch", "refused", String(r.status), r.status >= 400);
  r = await anon("POST", "/api/vouchers/redeem", { voucher: v.body.voucher, amount: 3000, merchant: "Anthropic", reference: "INV-1" });
  record("voucher", "The named merchant redeems for less (control)", "3000 at Anthropic", "200 captured 3000, 500 released", summarise(r), r.status === 200 && r.body.capturedAmount === 3000);
  r = await anon("POST", "/api/vouchers/redeem", { voucher: v.body.voucher, merchant: "Anthropic" });
  record("voucher", "Redeem the same voucher again", "second redemption", "409", String(r.status), r.status === 409);
  r = await A.capture({ transactionId: hold.body.transactionId, amount: 100 });
  record("settlement", "Capture a hold that is already captured", "double settlement", "409", String(r.status), r.status === 409);

  // ================= 4. Delegation =================
  r = await A.delegate({ name: "wide", perTxnLimit: 5001, dailyLimit: 15000, totalLimit: 30000, approvalAbove: 2000 });
  record("delegation", "Carve a sub-mandate wider than the parent", "child per-txn 5001 vs parent 5000", "400 with field errors", summarise(r), r.status === 400);
  r = await A.delegate({ name: "no-questions", perTxnLimit: 1000, dailyLimit: 1000, totalLimit: 1000, approvalAbove: null });
  record("delegation", "Carve a sub-mandate that never asks a human", "approvalAbove null under a parent that asks above $20", "400 — a child must ask at or below the parent", summarise(r), r.status === 400);
  r = await A.delegate({ name: "elsewhere", perTxnLimit: 1000, dailyLimit: 1000, totalLimit: 1000, approvalAbove: 1000, allowedMerchants: ["Namecheap"] });
  record("delegation", "Carve a sub-mandate for a merchant the parent cannot use", "child allowed Namecheap", "400", summarise(r), r.status === 400);
  r = await A.delegate({ name: "forever", perTxnLimit: 1000, dailyLimit: 1000, totalLimit: 1000, approvalAbove: 1000, expiresAt: "2099-01-01" });
  record("delegation", "Carve a sub-mandate that outlives the parent", "expiry 2099 vs parent's 30 days", "400", summarise(r), r.status === 400);
  const child = await A.delegate({ name: "helper", perTxnLimit: 1500, dailyLimit: 2000, totalLimit: 2000, approvalAbove: 1000, allowedMerchants: ["OpenAI"], agentName: "helper-1" });
  record("delegation", "Carve a narrower sub-mandate (control)", "child $10/txn, OpenAI only", "201 + token", String(child.status), child.status === 201 && String(child.body.token).startsWith("mnd_"));
  const K = agent(child.body.token);
  r = await K.authorize({ amount: 500, merchant: "Anthropic" });
  record("delegation", "Helper buys where the parent may but it may not", "Anthropic; child allowed OpenAI only", "declined merchant", summarise(r), declined(r, "merchant"));
  const before = (await A.mandate()).body.remaining?.today;
  const kOk = await K.authorize({ amount: 900, merchant: "OpenAI" });
  const after = (await A.mandate()).body.remaining?.today;
  record("delegation", "Helper's spend comes out of the parent's limits", `parent today: ${before} → ${after}`, "parent remaining falls by 900", `${before} → ${after}`, approved(kOk) && before - after === 900);
  let deep = K, depthReached = 1, refusal = null;
  for (let lvl = 2; lvl <= 5; lvl++) {
    const x = await deep.delegate({ name: `level-${lvl}`, perTxnLimit: 900, dailyLimit: 900, totalLimit: 900, approvalAbove: 500, allowedMerchants: ["OpenAI"] });
    if (x.status !== 201) { refusal = x; break; }
    deep = agent(x.body.token); depthReached = lvl;
  }
  record("delegation", "Delegate deeper and deeper", "parent → child → … until refused", "stops at depth 3", `reached depth ${depthReached}; then ${refusal ? summarise(refusal) : "never refused"}`, depthReached === 3 && refusal?.status === 400);
  let capped = null, minted = 0;
  for (let i = 0; i < 12; i++) { const x = await A.delegate({ name: `many-${i}`, perTxnLimit: 100, dailyLimit: 100, totalLimit: 100, approvalAbove: 50, allowedMerchants: ["OpenAI"] }); if (x.status !== 201) { capped = x; break; } minted++; }
  record("delegation", "Mint sub-mandates in a loop", "12 more children against a cap of 10 live ones", "refused at the cap (or the rate limit)", `${minted} minted, then ${capped ? summarise(capped) : "never refused"}`, capped !== null && minted >= 1 && minted <= 9 && (capped.status === 400 || capped.status === 429) && /at most|slow down/.test(String(capped.body.error ?? "") + JSON.stringify(capped.body.errors ?? "")));
  // Owner revokes the parent → every child dies with it.
  await p.goto(BASE + "/mandates/" + main.id, { waitUntil: "networkidle" });
  await Promise.all([p.waitForURL(/\/mandates\//), p.locator("button", { hasText: "Revoke now" }).click()]);
  await sleep(500);
  r = await K.authorize({ amount: 100, merchant: "OpenAI" });
  const r2 = await A.authorize({ amount: 100, merchant: "OpenAI" });
  record("delegation", "Helper keeps spending after the parent is revoked", "owner revoked the parent", "child and parent both refused", `child ${summarise(r)}; parent ${summarise(r2)}`, !approved(r) && !approved(r2));
  r = await K.capture({ transactionId: kOk.body.transactionId });
  record("delegation", "Helper settles its own open hold after revocation (control)", "capture on a hold made before the revoke", "allowed — closing a dying mandate's holds must still work", String(r.status), r.status === 200);

  // ================= 5. Idempotency and replay =================
  const key = "rt-" + Date.now();
  const first = await O.authorize({ amount: 700, merchant: "OpenAI", purpose: "idem" }, { "idempotency-key": key });
  const second = await O.authorize({ amount: 700, merchant: "OpenAI", purpose: "idem" }, { "idempotency-key": key });
  record("replay", "Retry with the same key and body (control)", "network retry", "same transaction, no second hold", `${first.body.transactionId === second.body.transactionId}`, approved(first) && first.body.transactionId === second.body.transactionId);
  r = await O.authorize({ amount: 4900, merchant: "OpenAI", purpose: "idem" }, { "idempotency-key": key });
  record("replay", "Reuse the key with a bigger purchase", "same key, amount 700 → 4900", "422, not the cached approval", String(r.status), r.status === 422);
  r = await O.authorize({ amount: 700, merchant: "OpenAI" }, { "idempotency-key": "mcp:forged" });
  record("replay", "Use the MCP channel's key namespace from REST", "idempotency-key mcp:…", "400", String(r.status), r.status === 400);
  await O.void({ transactionId: first.body.transactionId });

  // ================= 6. Tokens =================
  r = await agent("mnd_" + "a".repeat(40)).authorize({ amount: 100, merchant: "OpenAI" });
  record("token", "Guess a token", "well-formed, unknown", "401", String(r.status), r.status === 401);
  r = await agent(main.token.slice(0, -1) + (main.token.endsWith("a") ? "b" : "a")).authorize({ amount: 100, merchant: "OpenAI" });
  record("token", "Flip one character of a real token", "near-miss", "401", String(r.status), r.status === 401);
  r = await A.mandate();
  record("token", "Read the mandate with a revoked token", "GET /api/agent/mandate after revoke", "still readable (status: revoked), nothing spendable", `${r.status} ${r.body.status ?? ""}`, r.status === 200 && r.body.status === "revoked");

  // ================= 7. The panic button =================
  const fresh = await issue({ name: "Red team — after freeze", perTxnLimit: "50", dailyLimit: "150", totalLimit: "300", approvalAbove: "20", vetoAbove: "", allowedMerchants: "" });
  const F = agent(fresh.token);
  const askF = await F.authorize({ amount: 3000, merchant: "OpenAI", purpose: "freeze me" });
  const linkF = await waitLink(new RegExp(`${BASE}/a/${askF.body.approvalId}\\?d=approve&t=[^\\s]+`, "g"));
  await anon("POST", linkF.replace(BASE, "").replace("/a/", "/api/approvals/onetap/"));
  await p.goto(BASE + "/", { waitUntil: "networkidle" });
  await p.locator("details.panic > summary").click();
  await p.fill("#panic-reason", "red team drill");
  await p.locator("details.panic button[type=submit]").click();
  await p.waitForSelector(".notice.frozen", { timeout: 20000 });
  r = await F.authorize({ amount: 100, merchant: "OpenAI" });
  record("freeze", "Small in-scope purchase while the workspace is frozen", "$1.00, every term satisfied", "declined frozen", summarise(r), declined(r, "frozen"));
  r = await F.authorize({ amount: 3000, merchant: "OpenAI", purpose: "freeze me" });
  record("freeze", "Spend a valid, already-approved allowance while frozen", "the owner approved this exact purchase a moment ago", "declined frozen — the freeze beats the allowance", summarise(r), declined(r, "frozen"));
  r = await O.authorize({ amount: 100, merchant: "OpenAI" });
  record("freeze", "A different mandate in the same workspace while frozen", "unrelated token", "declined frozen — every rail", summarise(r), declined(r, "frozen"));
  await p.locator(".notice.frozen button", { hasText: "Unfreeze" }).click();
  await p.waitForSelector(".notice.frozen", { state: "detached", timeout: 20000 });
  r = await F.authorize({ amount: 3000, merchant: "OpenAI", purpose: "freeze me" });
  record("freeze", "The allowance after unfreezing (control)", "same request", "approved by allowance", summarise(r), approved(r) && r.body.rule === "allowance");
  if (approved(r)) await F.void({ transactionId: r.body.transactionId });

  // ================= 8. The record =================
  const chain = await p.evaluate(async () => (await fetch("/api/ledger/verify")).json());
  record("ledger", "Every decision above is in a hash chain that verifies end to end", `${chain.checked ?? chain.count ?? "?"} rows`, "ok", JSON.stringify(chain).slice(0, 80), chain.ok === true);

  await b.close();
} catch (e) {
  console.log("FAIL exception:", e?.message ?? e);
  console.log(out.slice(-1500));
  results.push({ group: "harness", title: "run completed", attempt: "", expect: "", got: String(e?.message ?? e).slice(0, 120), pass: false });
} finally {
  try { process.kill(-app.pid, "SIGTERM"); } catch { app.kill("SIGTERM"); }
}

// ---- summary ----
const attacks = results.filter((r) => !/\(control\)/.test(r.title));
const controls = results.filter((r) => /\(control\)/.test(r.title));
const failed = results.filter((r) => !r.pass);
console.log(`\n${attacks.length} adversarial attempts, ${attacks.filter((r) => r.pass).length} stopped; ${controls.length} legitimate controls, ${controls.filter((r) => r.pass).length} went through as they should.`);
console.log(failed.length ? `${failed.length} FAILED` : "all red-team scenarios held");

if (process.env.REDTEAM_WRITE === "1") {
  let commit = ""; try { commit = execSync("git rev-parse --short HEAD").toString().trim(); } catch {}
  const groups = [...new Set(results.map((r) => r.group))];
  const md = [`# Red-team results`, ``, `*Generated by \`npm run redteam\` on ${new Date().toISOString().slice(0, 10)}${commit ? ` at commit \`${commit}\`` : ""}. Re-run it yourself; the script is [\`tests/redteam.mjs\`](../tests/redteam.mjs).*`, ``,
    `Every row is an action an agent could attempt against a Mandate it holds. "Stopped" means no approved, capturable authorisation came out of it. Rows marked *(control)* are the legitimate counterpart — the same path used properly — to show the safeguard distinguishes the two rather than blocking everything.`, ``,
    `**${attacks.length} adversarial attempts, ${attacks.filter((r) => r.pass).length} stopped. ${controls.length} legitimate controls, ${controls.filter((r) => r.pass).length} allowed.**`, ``];
  for (const g of groups) {
    md.push(`## ${g[0].toUpperCase() + g.slice(1)}`, ``, `| Attempt | What was tried | Expected | Got | |`, `|---|---|---|---|---|`);
    for (const r of results.filter((x) => x.group === g)) md.push(`| ${r.title} | ${r.attempt} | ${r.expect} | \`${String(r.got).replace(/\|/g, "\\|")}\` | ${r.pass ? "✅" : "❌"} |`);
    md.push(``);
  }
  md.push(`## Not covered here`, ``, `Card (Stripe Issuing) authorisations and the LLM proxy's price enforcement are exercised with signed Stripe events and a stub upstream in the end-to-end suite (\`npm run test:e2e\`), and the SSRF, key-rotation and receipt-redaction checks live in the integration suite (\`npm run test:integration\`). The full review is [\`SECURITY-AUDIT.md\`](SECURITY-AUDIT.md).`, ``);
  writeFileSync(new URL("../docs/RED-TEAM.md", import.meta.url), md.join("\n"));
  console.log("wrote docs/RED-TEAM.md");
}
process.exit(failed.length ? 1 : 0);
