// Captures the README screenshots from a local production build.
//   npm run build && node scripts/screenshots.mjs
// Needs Postgres (DATABASE_URL or the docker-compose default) and Playwright's
// Chromium (PW_CHROMIUM=/path/to/chrome to point at one). Writes docs/images/*.png.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { chromium } from "playwright";

const PORT = Number(process.env.SHOT_PORT ?? 3150);
const BASE = `http://localhost:${PORT}`;
const OUT = "docs/images";
mkdirSync(OUT, { recursive: true });

// `next start` loads .env itself; the fallbacks below must not override a
// real secret there (the OAuth signing keys are encrypted under it).
const dotenv = existsSync(".env") ? Object.fromEntries(readFileSync(".env", "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^['"]|['"]$/g, "")]; })) : {};
const secret = (k) => process.env[k] ?? dotenv[k];
let out = "";
const app = spawn("npx", ["next", "start", "-p", String(PORT)], { env: {
  ...process.env, ALLOW_SEED: "1", APP_URL: BASE,
  MANDATE_ENCRYPTION_KEY: secret("MANDATE_ENCRYPTION_KEY") ?? Buffer.alloc(32, 7).toString("base64"),
  RECEIPT_SIGNING_KEY: secret("RECEIPT_SIGNING_KEY") ?? Buffer.alloc(32, 9).toString("base64"),
  NOTIFY_SECRET: secret("NOTIFY_SECRET") ?? Buffer.alloc(32, 5).toString("base64"),
  BETTER_AUTH_SECRET: secret("BETTER_AUTH_SECRET") ?? "screenshots-secret-0123456789abcdef0123456789",
  LEGAL_OPERATOR_NAME: "Mandate", LEGAL_CONTACT_EMAIL: "hello@example.com",
  SMTP_URL: "", RESEND_API_KEY: "",
}, stdio: ["ignore", "pipe", "pipe"] });
app.stdout.on("data", (d) => { out += d.toString(); });
app.stderr.on("data", (d) => { out += d.toString(); });
const waitFor = async (url, ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { try { const r = await fetch(url); if (r.ok || r.status === 307) return; } catch {} await new Promise((r) => setTimeout(r, 400)); } throw new Error("server did not start:\n" + out.slice(-800)); };
const lastLink = (re) => [...out.matchAll(re)].pop()?.[0];

try {
  await waitFor(BASE + "/");
  const b = await chromium.launch({ executablePath: process.env.PW_CHROMIUM });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  await ctx.addCookies([{ name: "theme", value: "dark", url: BASE }]);
  // Nothing outside the app matters for the pictures; block it so offline runs work too.
  await ctx.route((u) => !u.href.startsWith(BASE), (route) => route.abort());
  const p = await ctx.newPage();

  await p.goto(BASE + "/", { waitUntil: "load" });
  await p.screenshot({ path: `${OUT}/landing.png` });

  // Sign in through the console-printed magic link, then seed.
  const email = `demo-${Date.now()}@example.com`;
  await p.goto(BASE + "/sign-in", { waitUntil: "load" });
  await p.fill("#email", email); await p.click("form.form button[type=submit]");
  await p.waitForSelector(".notice.ok"); await new Promise((r) => setTimeout(r, 800));
  const link = lastLink(new RegExp(`${BASE}/api/auth/magic-link/verify\\?[^\\s]+`, "g"));
  if (!link) throw new Error("no sign-in link in server output");
  await p.goto(link, { waitUntil: "load" });
  const seeded = await p.evaluate(() => fetch("/api/dev/seed", { method: "POST" }).then(async (r) => ({ status: r.status, text: await r.text() })));
  if (seeded.status !== 200) throw new Error(`seed failed ${seeded.status}: ${seeded.text.slice(0, 300)}\n${out.slice(-2500)}`);

  await p.goto(BASE + "/", { waitUntil: "load" });
  await p.screenshot({ path: `${OUT}/exposure.png` });

  const href = await p.locator('a[href^="/mandates/"]', { hasText: "Offsite travel" }).first().getAttribute("href");
  await p.goto(BASE + href, { waitUntil: "load" });
  await p.screenshot({ path: `${OUT}/mandate.png` });

  await p.goto(BASE + "/stats", { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 600));
  await p.screenshot({ path: `${OUT}/stats.png` });

  await p.goto(BASE + "/approvals", { waitUntil: "load" });
  await p.screenshot({ path: `${OUT}/approvals.png` });

  await p.goto(BASE + "/activity", { waitUntil: "load" });
  await p.screenshot({ path: `${OUT}/activity.png` });

  await p.goto(BASE + "/connect?rail=python", { waitUntil: "load" });
  await p.screenshot({ path: `${OUT}/connect.png` });

  await p.goto(BASE + "/ledger", { waitUntil: "load" });
  await p.screenshot({ path: `${OUT}/ledger.png` });

  await p.goto(BASE + "/anchors", { waitUntil: "load" });
  await p.screenshot({ path: `${OUT}/anchors.png` });

  await b.close();
  console.log(`wrote ${OUT}/{landing,exposure,mandate,stats,approvals,activity,connect,ledger,anchors}.png`);
} finally {
  app.kill("SIGTERM");
}
process.exit(0);
