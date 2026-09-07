# Launch runbook: from this repo to a Reddit beta

Everything below is in order. Budget an afternoon for steps 1–7; step 8 (Stripe cards) is separate and can come weeks later.

## 0. Accounts you need (all free tiers)

| Service | For | Sign up |
|---|---|---|
| GitHub | the repo (already there) | github.com |
| Vercel | hosting | vercel.com — sign in with GitHub |
| Neon | Postgres | neon.tech — sign in with GitHub |
| Resend | sign-in links, invitations, alerts | resend.com |
| A domain | e.g. `getmandate.app` — buy anywhere; Cloudflare Registrar or Namecheap are fine | |
| Google Cloud | "Sign in with Google" (optional but worth it) | console.cloud.google.com |
| Sentry | error alerts | sentry.io |
| Better Uptime / UptimeRobot | a ping every minute | betteruptime.com |

## 1. Secrets (generate once, keep in a password manager)

```bash
openssl rand -base64 32   # BETTER_AUTH_SECRET
openssl rand -base64 32   # NOTIFY_SECRET
openssl rand -base64 32   # MANDATE_ENCRYPTION_KEY   (losing it = stored provider keys unreadable)
openssl rand -base64 32   # RECEIPT_SIGNING_KEY      (changing it = old receipts stop verifying online)
openssl rand -hex 32      # CRON_SECRET
```

## 2. Database (Neon)

1. New project → region closest to your users (US East for a Reddit beta). Postgres 16.
2. Copy the **pooled** connection string (ends in `-pooler…neon.tech/…?sslmode=require`). That is `DATABASE_URL`.
3. Settings → Compute → set auto-suspend to the maximum the plan allows (cold starts hurt agent latency; mandatory for the card rail later).
4. From your Mac, create the tables:
   ```bash
   cd ~/projects/Mandate
   DATABASE_URL='postgres://…neon.tech/…?sslmode=require' npm run db:migrate
   ```
   Repeat this command after any future change under `drizzle/`.

## 3. Email (Resend)

1. Add your domain, add the DNS records it shows (SPF, DKIM, MX for bounces), wait for "Verified".
2. Create an API key → `RESEND_API_KEY`.
3. `EMAIL_FROM="Mandate <hello@yourdomain>"` — must be on the verified domain.
4. Send yourself a test from the Resend dashboard to confirm delivery.

## 4. Deploy (Vercel)

1. Add New → Project → import `Ivan825/Mandate`. Framework: Next.js. Leave build settings default.
2. Environment variables (Production). Paste every one:
   ```
   DATABASE_URL, BETTER_AUTH_SECRET, NOTIFY_SECRET, MANDATE_ENCRYPTION_KEY, RECEIPT_SIGNING_KEY,
   APP_URL=https://yourdomain            (the final domain, https, no trailing slash)
   RESEND_API_KEY, EMAIL_FROM,
   LEGAL_OPERATOR_NAME="Your name or company", LEGAL_CONTACT_EMAIL=hello@yourdomain,
   OPERATOR_EMAILS=you@yourdomain, CRON_SECRET,
   SENTRY_DSN                            (from step 6; can be added later)
   ```
3. Deploy. First build takes ~2 minutes.
4. Settings → Domains → add your domain, set the DNS it asks for. Wait for the certificate.
5. Settings → Functions → enable **Fluid Compute** (lets the API proxy stream long responses).
6. Settings → Deployment Protection → **off** for production (agents and Stripe can't pass a browser challenge). If you enable Attack Challenge Mode later, exclude `/api/*` and `/.well-known/*`.
7. Cron is picked up from `vercel.json` automatically; check Settings → Cron Jobs shows `/api/cron/cleanup` daily.

## 5. Google sign-in (optional, 15 minutes)

1. Google Cloud → new project → APIs & Services → OAuth consent screen: External; app name "Mandate"; support email; homepage `https://yourdomain`; privacy `https://yourdomain/privacy`; terms `https://yourdomain/terms`. Scopes: email, profile, openid. **Publish** it (status *In production*), otherwise only listed testers can sign in.
2. Credentials → OAuth client ID → Web application. Authorised JavaScript origin `https://yourdomain`; authorised redirect URI `https://yourdomain/api/auth/callback/google`.
3. Add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to Vercel and redeploy.

## 6. Watch it

1. Sentry → new project (Next.js) → copy the DSN → `SENTRY_DSN` on Vercel. Unhandled errors from every route and server action arrive as events.
2. Uptime monitor on `https://yourdomain/` every minute, alert to your phone.
3. Vercel → Logs: every agent request is a JSON line with a request id (`event: "decision"`, `"proxy.decision"`); filter by `mandateId` when someone reports a problem.

## 7. Prove it works before anyone else does

Do this on the live domain, in this order, as a stranger would:

1. Open the landing page; the top bar shows no configuration warning (you'd see it — you're an operator).
2. Sign in by email link on your phone. The link must arrive within a minute.
3. Add an agent, issue a mandate (defaults are fine), copy the token, revoke it, issue another.
4. Settings → add your email as a channel → "Send test" → it arrives.
5. Connect a real agent over MCP: in Claude Desktop, Settings → Connectors → Add custom connector → `https://yourdomain/api/mcp`. In Claude Code: `claude mcp add --transport http mandate https://yourdomain/api/mcp`. Approve on the consent page. Ask Claude to "list my mandates" and then to "request a $5 purchase at OpenAI". Approve the escalation from the email link. Ask it to retry.
   *This is the one flow that was tested against a simulated client, not Anthropic's real one. If it fails, copy the exact error — it will be a small fix.*
6. API proxy: store an OpenAI key, issue a proxy key, run one real completion with `OPENAI_BASE_URL=https://yourdomain/api/proxy/openai OPENAI_API_KEY=mpx_…`. Check the call on the Proxy page and the Ledger.
7. Export a receipt from the Ledger page and paste it into `POST https://yourdomain/api/receipts/verify` (curl) — `signatureValid: true`.
8. Invite a second email address as approver; accept on another browser; approve something.
9. Delete that second account from its Settings; confirm it's gone.

## 8. Cards (later — needs a US/UK/EU Stripe account approved for Issuing)

See DEPLOY.md §5. Until then the card section is invisible to users.

## 9. The Reddit post — what to say and not say

Say: control what your agents can spend on your existing accounts; works with Claude, ChatGPT, Cursor and anything that speaks MCP; meters OpenAI/Anthropic/Gemini spend through a proxy key the agent can't exceed; every decision in a signed ledger; free during the beta; open source (MIT).

Don't say yet: virtual cards (unless Issuing is approved), "bank-grade", "guaranteed", anything about custody of money.

Include: a 60-second GIF of connect-approve-retry, the link, a line about what you want feedback on, and where to report problems (`LEGAL_CONTACT_EMAIL` and GitHub Issues).

Have ready on launch day: your phone for uptime alerts, the Sentry tab, Vercel logs, and a saved reply for "how is this different from just setting a budget in OpenAI".

## 10. Housekeeping every week during the beta

- Sentry: zero unresolved events, or a fix in flight.
- Neon: storage well under the free limit (the cron keeps the growing tables trimmed).
- Resend: bounce and complaint rates near zero.
- Ledger export of your own workspace as a smoke test that signing still works.
- `npm audit --omit=dev` after any dependency bump.
