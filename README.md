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

## Run it locally

```bash
npm install
npm run db:push          # creates data/mandate.db
npm run dev              # http://localhost:3000
curl localhost:3000/api/dev/seed   # optional: demo agents, mandates and decisions
```

Then open the dashboard, click a mandate, copy its token and try the API:

```bash
curl -s -X POST localhost:3000/api/agent/authorize \
  -H 'Authorization: Bearer mnd_...' -H 'content-type: application/json' \
  -d '{"amount":1299,"merchant":"OpenAI","purpose":"API credits"}'
```

Responses: `200` approved, `403` declined (with the rule and reason), `202` pending (approve it in the inbox, then retry the identical request).

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

## Roadmap (the same record, extended)

1. Notifications: push/Telegram/WhatsApp on each pending approval, with one-tap approve.
2. Multi-user: households and teams; approvers other than the issuer; per-approver limits.
3. Receipts as signed PDFs; dispute packet generation for merchant and issuer.
4. Token and tool surfaces: LLM API key proxy and MCP gateway enforced by the same mandate.
5. Mandate templates from lending practice: sanction matrices, early-warning triggers, cooling-off periods.
