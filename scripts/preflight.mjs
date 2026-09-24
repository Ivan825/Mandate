// Pre-deploy check you can run from your machine against the production
// values before the first Vercel deploy:
//   DATABASE_URL=... APP_URL=... SMTP_URL=... node scripts/preflight.mjs
// It confirms the database is reachable and migrated, and that every secret
// production requires is present and well-formed. Prints one line per check.
import { Pool } from "pg";

const checks = [];
const ok = (n, c, d = "") => checks.push([c ? "ok  " : "FAIL", n, d]);
const env = (k) => process.env[k] ?? "";
const b64_32 = (v) => { try { return Buffer.from(v, "base64").length === 32; } catch { return false; } };

ok("APP_URL is https", /^https:\/\/[^/]+$/.test(env("APP_URL")), env("APP_URL") || "(unset)");
ok("BETTER_AUTH_SECRET >= 32 chars", env("BETTER_AUTH_SECRET").length >= 32);
ok("NOTIFY_SECRET >= 32 chars", env("NOTIFY_SECRET").length >= 32);
ok("MANDATE_ENCRYPTION_KEY is 32 bytes base64", b64_32(env("MANDATE_ENCRYPTION_KEY")));
ok("RECEIPT_SIGNING_KEY is 32 bytes base64", b64_32(env("RECEIPT_SIGNING_KEY")));
ok("CRON_SECRET set", env("CRON_SECRET").length >= 16);
ok("email delivery or Google sign-in", Boolean(env("SMTP_URL") || env("RESEND_API_KEY") || env("GOOGLE_CLIENT_ID")));
if (env("RESEND_API_KEY")) ok("EMAIL_FROM set for Resend", /@/.test(env("EMAIL_FROM")) && !/mandate\.local/.test(env("EMAIL_FROM")));
ok("LEGAL_CONTACT_EMAIL set", /@/.test(env("LEGAL_CONTACT_EMAIL")));
ok("OPERATOR_EMAILS set", /@/.test(env("OPERATOR_EMAILS")));

if (env("DATABASE_URL")) {
  const url = env("DATABASE_URL");
  const pool = new Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: true }, max: 1 });
  try {
    const v = await pool.query("select version()");
    ok("database reachable", true, v.rows[0].version.split(" ").slice(0, 2).join(" "));
    const m = await pool.query("select count(*)::int as n from drizzle.__drizzle_migrations").catch(() => null);
    ok("migrations applied", Boolean(m && m.rows[0].n >= 10), m ? `${m.rows[0].n} applied` : "run: npm run db:migrate");
    const t = await pool.query("select to_regclass('public.mcp_grants') as a, to_regclass('public.topups') as b, to_regclass('public.webhook_endpoints') as c");
    ok("schema current (mcp_grants, topups, webhook_endpoints)", Boolean(t.rows[0].a && t.rows[0].b && t.rows[0].c));
  } catch (e) { ok("database reachable", false, e.message); }
  await pool.end();
} else ok("DATABASE_URL set", false);

for (const [s, n, d] of checks) console.log(s, n, d ? "— " + d : "");
const failed = checks.filter((c) => c[0] === "FAIL").length;
console.log(failed ? `\n${failed} problem(s) — fix before deploying.` : "\nReady to deploy.");
process.exit(failed ? 1 : 0);
