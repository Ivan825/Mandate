# Deploying Mandate

Two supported shapes: **hosted** (Vercel + Neon) and **self-hosted** (Docker Compose). Both need the same environment variables; the hosted one needs a few accounts.

## 0. Secrets to generate once

```bash
openssl rand -base64 32   # BETTER_AUTH_SECRET
openssl rand -base64 32   # NOTIFY_SECRET
openssl rand -base64 32   # MANDATE_ENCRYPTION_KEY  (encrypts stored provider API keys)
openssl rand -base64 32   # RECEIPT_SIGNING_KEY     (Ed25519 seed; signs receipts)
```

All four are **required** whenever `NODE_ENV=production` (which is what `next start`, the Docker image and Vercel use): the app refuses to derive them from each other outside development, and the top bar shows a red configuration notice to signed-in users if one is missing or looks like a placeholder. Keep `MANDATE_ENCRYPTION_KEY` and `RECEIPT_SIGNING_KEY` somewhere durable: losing the first makes stored provider keys unreadable; rotating the second changes the receipt key id, and receipts signed with the old key no longer verify at `/api/receipts/verify` (they still verify offline against the old public key if you kept it).

## 1. Hosted: Vercel + Neon

1. **Neon**: create a project, copy the pooled connection string as `DATABASE_URL`.
2. **Vercel**: import the GitHub repo. Framework preset Next.js; no build overrides.
3. **Environment variables** (Production): `DATABASE_URL`, `BETTER_AUTH_SECRET`, `APP_URL` (your final https domain), `NOTIFY_SECRET`, `MANDATE_ENCRYPTION_KEY`, `RECEIPT_SIGNING_KEY`, `RESEND_API_KEY`, `EMAIL_FROM`, `LEGAL_OPERATOR_NAME`, `LEGAL_CONTACT_EMAIL`, `OPERATOR_EMAILS`, `CRON_SECRET`, and `SENTRY_DSN`. Production refuses to consider itself configured without email delivery (or Google) — outside users cannot read your logs.
4. **Migrate** from your machine once: `DATABASE_URL=<neon> npm run db:migrate`. (Repeat after any change under `drizzle/`.)
5. Deploy. Sign in with your email; until step 2 below, the link appears in Vercel's function logs.

### Vercel checklist (things that bite once real people arrive)

- **Set the final domain before inviting anyone.** Passkeys bind to the hostname in `APP_URL`; a passkey registered on `*.vercel.app` will not work on your custom domain. OAuth clients (agents) also register against that URL.
- **Function timeouts.** The API proxy streams for up to 300 s (`maxDuration` in its route); on the Hobby plan enable Fluid Compute (Project → Settings → Functions) or the stream is cut at the plan's ceiling. Everything else finishes in a few seconds.
- **Neon auto-suspend + cold starts vs Stripe's 2-second window.** For the card rail, keep Neon's compute from suspending (its "auto-suspend" setting, or the paid always-on tier) — a cold database plus a cold function can miss the authorisation deadline, and Stripe then applies your account's timeout rule (set it to *decline*).
- **Turn off Vercel Deployment Protection / Attack Challenge for the API paths** (`/api/mcp`, `/api/proxy/*`, `/api/webhooks/stripe`, `/api/agent/*`, `/.well-known/*`): agents and Stripe cannot answer a browser challenge.
- **Cron.** `vercel.json` schedules `/api/cron/cleanup` daily; set `CRON_SECRET` (Vercel sends it as the bearer automatically).
- **Operators.** Set `OPERATOR_EMAILS` to your address(es): configuration warnings and the deployment table in Settings show only to you; everyone else sees a product.
- **Google OAuth consent screen** must be published (*In production*, not *Testing*) or only listed test users can sign in and their tokens expire after seven days.

## 2. Sign-in providers

- **Resend** (email links, invitations, alerts): verify your domain, create an API key → `RESEND_API_KEY`, `EMAIL_FROM="Mandate <sign-in@yourdomain>"`.
- **Google**: Google Cloud → OAuth consent screen (external; add the Terms and Privacy URLs `APP_URL/terms`, `APP_URL/privacy`) → Credentials → OAuth client (Web). Authorised redirect URI: `APP_URL/api/auth/callback/google` → `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
- **Passkeys** need nothing; they bind to the `APP_URL` hostname.

## 3. Notifications

Nothing to configure at deployment level. Each person adds an email address or a webhook URL (n8n, Zapier, Make, or your own endpoint) in Settings, and every approver in a workspace is notified through their own channels. `NOTIFY_WEBHOOK_URL` is an optional deployment-wide fallback for a single-owner self-host that hasn't set a channel yet.

## 4. Connect an agent (the real test)

- Claude Code: `claude mcp add --transport http mandate APP_URL/api/mcp`
- Claude Desktop / ChatGPT / Cursor: add a remote MCP server with the same URL. You'll be sent to the consent page once.
- Own code: use the REST token from a mandate, or the API proxy (`/proxy` page) with the SDK base URL.

## 5. Stripe Issuing: virtual cards and the prepaid balance

The card rail is the one part that needs something other than an account signup, so read this before promising cards to testers.

**What Stripe requires of the operator (you).** Stripe Issuing is available to businesses in the US, the UK and the EEA; the Stripe account that issues the cards must be in one of those, and *that* account's country sets the card currency and which cardholders you may serve (`STRIPE_ISSUING_REGION=US|GB|EU`). An Indian Stripe account cannot enable Issuing. The usual route for a founder outside those regions is a US entity: Stripe Atlas forms a Delaware C-corp or LLC with a US bank account and a Stripe account in a few days; after that you apply for Issuing from the dashboard (Issuing → Get started), describe the use case ("spend controls for AI agents: prepaid virtual cards with per-transaction, daily and lifetime limits, merchant allow-lists and real-time authorisation"), and wait for approval, typically one to three weeks. In test mode everything works immediately without approval, which is how you rehearse.

**Money flow.** Cards spend the *operator's* Issuing balance, so every user prepays: the Balance page sends them to Stripe Checkout, the `checkout.session.completed` webhook credits their workspace, and a card authorisation is declined the moment it would take that workspace below zero. Top-ups arrive in your Stripe payments balance (minus Stripe's fee, which you absorb); you move funds into the Issuing balance from the dashboard or by enabling auto-funding, and you must keep the Issuing balance ahead of the sum of user balances — Mandate declines against the user's balance, but Stripe declines against yours. Refunds of unspent balance are manual: revoke the mandates, refund the Checkout payment(s) from the dashboard, then record it so the balance and ledger match: `npx tsx scripts/credit.ts <workspaceId> -2500 USD "refund of cs_…"`. The same script with a positive amount grants beta credits without a payment.

**Configuration.** `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY` (card details are rendered in the browser through Stripe's Issuing Elements, never through our server), `STRIPE_WEBHOOK_SECRET`, `STRIPE_ISSUING_REGION`. Webhook endpoint `APP_URL/api/webhooks/stripe`, subscribed to: `issuing_authorization.request` (synchronous, answered within Stripe's two-second window before anyone is notified), `issuing_authorization.created`, `issuing_authorization.updated`, `issuing_transaction.created`, `issuing_card.updated`, `issuing_cardholder.updated`, `checkout.session.completed`, `checkout.session.async_payment_succeeded`. Every event is deduplicated by id.

**Per user.** Settings → cardholder details (legal name, date of birth, mobile for 3-D Secure, billing address in the deployment's region, and acceptance of Stripe's cardholder terms, which UK/EU cardholders must give explicitly). Then a mandate issued with "virtual card" ticked gets a card bound to it, with Stripe's own spending controls mirroring the mandate as a second line of defence. The mandate page shows the number, expiry and CVC to owners and admins on request; each reveal is written to the ledger. Freeze pauses the card without revoking the mandate; revoking cancels it.

**Rehearsal in test mode.** With test keys, tick "Send through Stripe test authorisation" on a mandate page: Stripe fires a real `issuing_authorization.request` at your webhook and the decision comes back through the same code path. The e2e suite also drives the webhook with locally signed events (no Stripe calls).

## 6. Self-hosted: Docker Compose

```bash
cp .env.example .env     # fill in the four secrets from step 0, POSTGRES_PASSWORD and APP_URL
docker compose up -d     # Postgres + app; migrations run on start
```

`docker-compose.yml` has no default secrets: it fails fast if any of `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `NOTIFY_SECRET`, `MANDATE_ENCRYPTION_KEY`, `RECEIPT_SIGNING_KEY` is unset. Put it behind HTTPS (Caddy, nginx, a tunnel): OAuth for agents and passkeys require a real origin, and `APP_URL` must be the https address. If clients reach Node with no reverse proxy at all, set `TRUST_PROXY=false` so forwarded-address headers are ignored.

## 7. What the hardening pass locks down (for your own review)

- **Agents see one workspace.** An OAuth client is bound, on the consent page, to the workspace the person was looking at; every MCP call resolves that binding, re-reads the member's current role, and refuses tokens whose consent was withdrawn in Settings even before the JWT expires. Only owners and admins can connect an agent that spends; approvers and viewers can connect read-only.
- **Retries never double-spend.** `Idempotency-Key` is reserved before the policy engine runs, so concurrent retries collapse to one decision; a *pending* answer is never replayed, so the retry after approval consumes the allowance.
- **Cards answer Stripe first.** Notifications and warnings run after the authorisation response is sent; an authorisation Stripe declines on its side after we approved is voided so it never counts as spend; partial captures accumulate; closed-without-capture releases the hold.
- **The proxy forwards only what it can price**: chat/responses/embeddings (OpenAI), messages (Anthropic), generateContent/streamGenerateContent/embedContent (Gemini), plus model listings. Path traversal, other endpoints, non-JSON bodies and bodies over 8 MB are refused; request and response headers are allow-listed; attachments, hidden Responses history, `n`, thinking tokens and snake_case Gemini configs are priced; a call that settles above the per-transaction limit or far above its estimate suspends the proxy key and alerts the approvers.
- **Receipts are verified against this server's key**, never a key embedded in the receipt.
- **Webhook targets must be public** (no loopback, private, link-local or metadata addresses; https outside development), checked when added and again before every delivery.
- **Rate limits live in Postgres** for auth endpoints too (magic links, token endpoint, anonymous client registration, invitations) and hold across serverless instances. Addresses come from `x-real-ip` / `cf-connecting-ip` / a single `x-forwarded-for`; set `TRUSTED_PROXIES` for a proxy chain, `TRUST_PROXY=false` when there is no proxy.
- **Reconnecting an agent** (Settings → Disconnect, then connect again in the client) invalidates every token from the earlier connection, even unexpired ones. Re-connecting an already-consented client skips the consent page, so its workspace binding stays as it was; disconnect first to move it.
- **The public verifier says what it covers**: `coverage: "chain"` with `eventsCovered: true` only for a full-workspace receipt; a mandate slice is `rows-only`.
- Also: same-origin-only `next=` redirects; escaped invitation emails; session revocation by id (tokens never reach the page); TLS-verified database connections by default; int4-safe amounts; `ledger:export` enforced; show-once plaintexts swept at creation; `POST`-only seeding; role-gated buttons with a plain-language reason when a role cannot act; ownership transfer on the Members page; timestamps in the viewer's own timezone.

## Health checks

- `APP_URL/.well-known/oauth-protected-resource/api/mcp` returns JSON → OAuth discovery works.
- `APP_URL/api/mcp` without a token returns 401 with `WWW-Authenticate` → MCP challenge works.
- `APP_URL/.well-known/mandate-receipt-key` returns a PEM → receipt signing is configured.
- Settings page shows every capability's state.
