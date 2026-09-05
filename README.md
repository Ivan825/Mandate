# Mandate

Scoped, revocable spending authority for AI agents.

An agent never holds your card or your API key. It holds a **mandate**: a limit per transaction, per day and in total; the merchants it may pay; the hours it may act; and the amount above which it must ask you first. Every attempt is decided against those terms, every decision is written to a hash-chained ledger, and revoking a mandate kills the agent's credential instantly.

Think of it as a sanction letter for an agent, with the loan-book view to match.

## What's in the MVP

- **Exposure book** (`/`): every agent's mandate, utilisation today and lifetime, pending approvals, recent decisions.
- **Issue mandate** (`/mandates/new`): limits, merchant allow-list, blocked categories, active hours, expiry, escalation threshold; optional Stripe virtual card.
- **Approval inbox** (`/approvals`): requests above the threshold. "Approve once" grants a one-time allowance; the agent retries and goes through.
- **Ledger** (`/ledger`): append-only, SHA-256 hash-chained; verify in one click; export as a JSON receipt for a dispute.
- **Agent API**: `POST /api/agent/authorize` and `GET /api/agent/mandate`, authenticated by the mandate token.
- **Stripe Issuing**: real-time authorisation webhook decides each card swipe with the same policy engine.
- **MCP server** (`mcp/server.mjs`): gives Claude Code, Cursor or any MCP client `check_mandate` and `request_purchase` tools.
- **Notifications** (`/settings`): Telegram (Approve / Deny buttons) and a generic webhook; one-tap links are signed, expire with the request, and always confirm before deciding so link previews can't approve anything.
- **Approval lifecycle**: unanswered requests expire after `APPROVAL_TTL_HOURS` (24 by default); granted allowances lapse unused after 24 h; a denial blocks the same request for 6 h.
- **Idempotency**: send `Idempotency-Key` on `POST /api/agent/authorize` and a retry returns the stored answer (`Idempotent-Replayed: true`) instead of a second decision.

## Run it locally

```bash
npm install
npm run db:push          # creates data/mandate.db
npm run dev              # http://localhost:3000
curl localhost:3000/api/dev/seed   # optional: demo agents, mandates and decisions (dev only; returns the demo tokens)
npm test                 # policy-engine unit tests
```

With `ADMIN_PASSWORD` set, the dashboard needs a sign-in; the agent API and the Stripe webhook never do.

Then open the dashboard, click a mandate, copy its token and try the API:

```bash
curl -s -X POST localhost:3000/api/agent/authorize \
  -H 'Authorization: Bearer mnd_...' -H 'content-type: application/json' \
  -d '{"amount":1299,"merchant":"OpenAI","purpose":"API credits"}'
```

Responses: `200` approved, `403` declined (with the rule and reason), `202` pending (approve it in the inbox, then retry the identical request).

## What has been verified

- Policy engine: 8 unit tests covering rule order, exact merchant matching, allowance binding (exact amount + merchant, 24h expiry), overnight hours windows, timezone-correct expiry, denial cooling-off and the cap on open approvals.
- Concurrency: 12 parallel requests against a daily limit approve exactly as many as fit and decline the rest; three parallel retries of one approved request consume the allowance exactly once. Authorisation runs in an IMMEDIATE transaction with the ledger write.
- Ledger: editing one row breaks verification at that row; restoring it repairs the chain.
- Browser flow: sign-in gate, wrong password, approve from the inbox, form validation with values preserved, agent token shown once and never again.
- Notifications: webhook fires after the request commits with signed approve/deny links; a tampered link is rejected; the one-tap confirm page decides once and reports "already approved" afterwards; an unanswered request expires after the TTL with an `approval.expired` ledger event.
- Idempotency: the same `Idempotency-Key` twice returns one stored answer and creates one transaction.

## Policy engine

`lib/policy.ts` is pure and checks rules in the order a credit officer would: status and expiry, active hours, merchant scope, blocked category, per-transaction limit, daily limit, total limit, then escalation. Escalation returns `pending` unless an unused human approval covers the amount at that merchant, in which case it is consumed and the request is approved.

## Stripe virtual cards (optional)

Set `STRIPE_SECRET_KEY` (test mode is fine) and `STRIPE_WEBHOOK_SECRET`, point a Stripe webhook for `issuing_authorization.request`, `issuing_authorization.created` and `issuing_transaction.created` at `/api/webhooks/stripe`. Issuing a mandate then also issues a virtual card whose every authorisation is decided by the mandate. Stripe's own spending limits are set as a second line of defence. The mandate page can fire a test authorisation to exercise the loop. Note that a card network cannot wait for a human: a `pending` decision declines the swipe and the approval sits in the inbox for the retry.

## Deploy

Vercel plus a hosted libSQL/Turso database:

```
DATABASE_URL=libsql://<your-db>.turso.io
DATABASE_AUTH_TOKEN=...
ADMIN_PASSWORD=...            # protects the dashboard; agent API and webhook stay open
NEXT_PUBLIC_BASE_URL=https://your-app.vercel.app
STRIPE_SECRET_KEY=...         # optional
STRIPE_WEBHOOK_SECRET=...     # optional
```

Run `npm run db:push` once against the production URL.

## Layout

```
app/                 pages, server actions, API routes
  api/agent/         agent-facing endpoints (token auth)
  api/webhooks/      Stripe Issuing real-time authorisation
  api/ledger/        verify and export the hash chain
lib/policy.ts        the decision engine (pure)
lib/service.ts       mandates, authorisation, approvals, exposure
lib/ledger.ts        hash-chained append-only log
lib/stripe.ts        card issuance and test helpers
mcp/server.mjs       zero-dependency stdio MCP server
```

## Security notes

- Agent tokens are stored as SHA-256 hashes and shown exactly once at issue. Revoking a mandate invalidates the token immediately.
- Every server action re-checks the owner session; the middleware is a convenience, not the boundary. The session cookie is an HMAC under the admin password, never the password itself.
- The Stripe webhook answers with the required `Stripe-Version` header, deduplicates events, and fails closed (declines) on any internal error. Never put the mandate token in Stripe metadata.
- `/api/dev/seed` is disabled in production unless `ALLOW_SEED=1`.
- The agent API is *advisory* on its own: merchant and amount are self-reported. It becomes binding when the payment runs through a Mandate-issued card (Stripe path), an API-key proxy, or an MCP gateway (roadmap items 3–4).

## What is still missing before this is a multi-user product

This is a working single-owner MVP, not a finished SaaS. In order of importance:

1. **Tenancy and real auth.** One owner today. Every table needs an `owner_id`, every query a `WHERE owner_id = ?`, per-user sessions (Auth.js or similar), and a per-tenant ledger chain. Until then, do not put two people's agents on one deployment.
2. **Binding enforcement beyond cards.** An API-key proxy (agent gets a proxied key; spend is metered by us) and an MCP gateway (tool calls carry the mandate).
3. **Stripe production readiness.** Real cardholder KYC data, issuing-currency constraints, reconciliation of captures/reversals/refunds (today an approved authorisation counts as spent in full), latency budget for the 2-second window near your Turso region.
4. **Operational**: structured logging with request ids, error reporting, per-token rate limits, incremental ledger verification (today it re-hashes the whole chain per view), grouped exposure queries, committed migrations (`drizzle-kit generate` + `migrate`) instead of `db:push`.
5. **Receipts as signed documents**: sign the chain head with a key kept outside the database so the operator cannot rewrite history unnoticed; PDF dispute packets.
6. **Mandate templates from lending practice**: sanction matrices, early-warning triggers, cooling-off periods, delegated approvers with their own limits.
