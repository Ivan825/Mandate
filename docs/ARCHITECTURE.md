# Architecture

Mandate is a single Next.js 15 application (App Router, server actions, route handlers) on Postgres 16 via Drizzle, with Better Auth for identity and OAuth. There are no background workers: anything that must happen after a response (notifications, ledger writes for side effects) runs in `after()` from `next/server`, and a daily cron trims the tables that grow.

```
Agent ──MCP/OAuth──┐
Agent ──proxy key──┼──▶ policy engine ──▶ ledger (hash chain) ──▶ receipts (Ed25519)
Agent ──mnd_ token─┤          │
Stripe ──webhook───┘          ▼
                        approvals ──▶ email / webhook ──▶ one-tap approve / deny
```

## Code layout

```
app/                      pages, server actions, API routes
  api/auth/[...all]       Better Auth (sign-in, OAuth 2.1 server, passkeys)
  api/mcp                 remote MCP server (requireMcpAuth)
  api/proxy/[provider]    API-key proxy for OpenAI / Anthropic / Gemini
  api/agent/              token-based REST for your own agents
  api/webhooks/stripe     real-time card authorisation + reconciliation
  api/ledger/, api/receipts/   export, verify
  api/cron/cleanup        daily housekeeping (CRON_SECRET bearer)
  api/health              `select 1` — uptime monitors and load balancers
  .well-known/            OAuth discovery and the receipt public key
  sign-in, consent, invite, members, workspaces, proxy, stats, settings, docs,
  a/[id] (one-tap approve/deny), terms, privacy
lib/auth.ts               Better Auth config (Google, magic link, passkey, orgs+roles, jwt, mcp, cimd)
lib/roles.ts              access control: owner, admin, approver, viewer
lib/schema.ts             Mandate tables (workspace-scoped, incl. mcp_grants)
lib/auth-schema.ts        auth tables (generated) + rate_limit
lib/policy.ts             the decision engine — pure, no I/O
lib/service.ts            mandates, authorisation, approvals, exposure, reconciliation
lib/balance.ts            prepaid balance for cards (advisory-locked, idempotent top-ups)
lib/stripe.ts             Issuing: cardholders, cards, ephemeral keys, Checkout top-ups
lib/proxy.ts, pricing.ts  API-key proxy: route allow-list, estimates, settlement; per-model prices
lib/ledger.ts, receipts.ts   per-workspace hash chain; Ed25519-signed receipts
lib/notify.ts, warnings.ts   email/webhook delivery, one-tap links; utilisation and velocity alerts
lib/mailer.ts             Resend | SMTP (nodemailer) | console
lib/idempotency.ts        reserve / complete / release around every decision
lib/ratelimit.ts, log.ts  Postgres rate limits; structured JSON logs with request ids
lib/env.ts                appUrl(), configProblems(), isOperator()
drizzle/                  committed SQL migrations (+ meta/ snapshots)
scripts/                  migrate, preflight, credit, screenshots
tests/                    unit, integration, e2e
mcp/server.mjs            zero-dependency stdio MCP server for one machine
deploy/                   AWS EC2 (compose + Caddy) and ECS Fargate (CloudFormation)
```

## The decision engine

`lib/policy.ts` is a pure function from *(mandate terms, facts about the mandate so far, the request)* to a decision: `approved`, `declined` with the rule that fired, or `pending` with an escalation. Rules run in a fixed order — status, expiry, active hours (in the mandate's timezone), blocked category, merchant allow-list, per-transaction limit, daily limit, total limit, prepaid balance (cards), then the "ask me above" threshold, which is where an existing unused approval can cover the request. Because it has no I/O it is unit-tested exhaustively and reused unchanged by every rail: REST, MCP, the proxy's pre-authorisation, and Stripe's real-time authorisation webhook.

`lib/service.ts` wraps it with the database: it loads facts inside a transaction with the mandate row locked, runs the engine, records the decision, consumes an approval if one applied, and schedules notifications after the response.

## Idempotency

Every decision path takes an idempotency key (`Idempotency-Key` header on REST; the tool call id on MCP; Stripe's event id for webhooks). `lib/idempotency.ts` **reserves** the key before deciding — a second request with the same key while the first is in flight gets a 409 with `retry-after`, not a second decision. Terminal answers (approved/declined) are stored and replayed byte-for-byte. A *pending* answer releases the reservation, so the agent's retry after approval is a real decision, which is what lets one approval be consumed exactly once even under parallel retries. Stale reservations are taken over after 60 s.

## Approvals

An escalation creates an approval row and notifies every approver in the workspace through the channels *they* chose (email, or a webhook). Links are signed with `NOTIFY_SECRET` and land on a confirm page, so a mail client's link preview can't approve anything. An approval is for one purchase of up to that amount at that merchant, valid 24 h; a denial blocks the same ask for 6 h; unanswered requests expire after 24 h. Approvers can decide but cannot issue mandates.

## The ledger and receipts

`lib/ledger.ts` appends one row per event (grant, decision, approval, revocation, top-up …) to a per-workspace chain: each row's hash covers the previous row's hash and the event payload. Verification is incremental from a checkpoint or full from genesis. Exports (`/api/ledger/export`) carry an Ed25519 signature over the chain head using `RECEIPT_SIGNING_KEY`; the public key is served at `/.well-known/mandate-receipt-key`, and `/api/receipts/verify` checks any receipt without a session — chain integrity, signature validity, and whether *this* server signed it. A receipt that carries its own public key is rejected: verification is always against the server's key.

## Identity and OAuth

Better Auth provides sessions (Google, magic link, passkeys), organisations with roles, and — via `@better-auth/mcp` — an OAuth 2.1 authorisation server with PKCE, RFC 8414/9728 discovery at the site root, Client-ID Metadata Documents (how Claude identifies itself) and RFC 7591 dynamic registration. At consent, `bindAgentAction` records an `mcp_grants` row tying the client to the workspace the person consented in; every MCP call re-checks that the grant exists, the token wasn't issued before the binding, and the member's current role may spend. Disconnecting in Settings deletes the grant, which invalidates every token from that client.

## Cards (Stripe Issuing)

When the operator configures Stripe, a mandate can carry a virtual card. The card is funded from a prepaid workspace balance (`lib/balance.ts`; top-ups via Checkout, idempotent on the Checkout session). Stripe's `issuing_authorization.request` webhook is answered synchronously by the same policy engine plus a balance check — fail-closed, and before any notification work. Captures, reversals, refunds and closed authorisations are reconciled into the ledger and the balance. Card details are shown through Stripe's Issuing Elements with a server-minted ephemeral key, so PANs never touch Mandate's servers.

## Hardening notes

- Agents bound to the workspace they were consented into; role re-checked live.
- Rate limits per token, proxy key, client address and auth endpoint, backed by Postgres so they hold across instances; client address from `x-forwarded-for` only when the proxy is trusted.
- Proxy: route allow-list per provider (generation endpoints only; `count_tokens` and `models` free), request- and response-header allow-lists, worst-case cost estimate before forwarding, settlement on reported usage, automatic key suspension on repeated overruns.
- Webhook targets resolved and checked against private, loopback, link-local, 6to4 and NAT64 ranges; HTTPS required in production.
- Provider keys encrypted with `MANDATE_ENCRYPTION_KEY` (AES-GCM); the key lives in the environment, not the database.
- Production refuses to start without `BETTER_AUTH_SECRET`, `NOTIFY_SECRET`, `MANDATE_ENCRYPTION_KEY`, `RECEIPT_SIGNING_KEY`; `npm run preflight` checks a deployment's configuration and migrations before the first deploy.
- CSP with no `unsafe-eval` in production; Stripe hosts allow-listed.
- Structured JSON logs with a request id on every decision.
