# Deploying Mandate

Two supported shapes: **hosted** (Vercel + Neon) and **self-hosted** (Docker Compose). Both need the same environment variables; the hosted one needs a few accounts.

## 0. Secrets to generate once

```bash
openssl rand -base64 32   # BETTER_AUTH_SECRET
openssl rand -base64 32   # NOTIFY_SECRET
openssl rand -base64 32   # MANDATE_ENCRYPTION_KEY  (encrypts stored provider API keys)
openssl rand -base64 32   # RECEIPT_SIGNING_KEY     (Ed25519 seed; signs receipts)
```

Keep `MANDATE_ENCRYPTION_KEY` and `RECEIPT_SIGNING_KEY` somewhere durable: losing the first makes stored provider keys unreadable; changing the second changes the receipt key id (old receipts still verify against the old public key, which the export embeds).

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

- **Telegram**: @BotFather → `/newbot` → `TELEGRAM_BOT_TOKEN`. Each person adds their own chat id in Settings. `TELEGRAM_CHAT_ID` is only a deployment-wide fallback.
- **Webhook / email** need no deployment setup; people add them in Settings.

## 4. Connect an agent (the real test)

- Claude Code: `claude mcp add --transport http mandate APP_URL/api/mcp`
- Claude Desktop / ChatGPT / Cursor: add a remote MCP server with the same URL. You'll be sent to the consent page once.
- Own code: use the REST token from a mandate, or the API proxy (`/proxy` page) with the SDK base URL.

## 5. Stripe Issuing (optional; US/UK/EU entities only)

`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`. Webhook endpoint `APP_URL/api/webhooks/stripe` subscribed to `issuing_authorization.request` (synchronous), `issuing_authorization.created`, `issuing_authorization.updated`, `issuing_transaction.created`. Fill in cardholder details in Settings before issuing a mandate with a card.

## 6. Self-hosted: Docker Compose

```bash
cp .env.example .env     # fill in the secrets from step 0 and APP_URL
docker compose up -d     # Postgres + app; migrations run on start
```

Put it behind HTTPS (Caddy, nginx, a tunnel): OAuth for agents and passkeys require a real origin.

## Health checks

- `APP_URL/.well-known/oauth-protected-resource/api/mcp` returns JSON → OAuth discovery works.
- `APP_URL/api/mcp` without a token returns 401 with `WWW-Authenticate` → MCP challenge works.
- `APP_URL/.well-known/mandate-receipt-key` returns a PEM → receipt signing is configured.
- Settings page shows every capability's state.
