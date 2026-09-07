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
3. **Environment variables** (Production): `DATABASE_URL`, `BETTER_AUTH_SECRET`, `APP_URL` (`https://<app>.vercel.app`, later your domain), `NOTIFY_SECRET`, `MANDATE_ENCRYPTION_KEY`, `RECEIPT_SIGNING_KEY`, `LEGAL_OPERATOR_NAME`, `LEGAL_CONTACT_EMAIL`.
4. **Migrate** from your machine once: `DATABASE_URL=<neon> npm run db:migrate`. (Repeat after any change under `drizzle/`.)
5. Deploy. Sign in with your email; until step 2 below, the link appears in Vercel's function logs.

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

## 5. Stripe Issuing (optional; US/UK/EU entities only)

`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`. Webhook endpoint `APP_URL/api/webhooks/stripe` subscribed to `issuing_authorization.request` (synchronous), `issuing_authorization.created`, `issuing_authorization.updated`, `issuing_transaction.created`. Fill in cardholder details in Settings before issuing a mandate with a card.

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
