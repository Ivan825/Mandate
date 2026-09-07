# Mandate

Scoped, revocable spending authority for AI agents.

An agent never holds your card, your API key or your account. It holds a **mandate**: a limit per transaction, per day and in total; the merchants it may pay; the hours it may act; and the amount above which it must ask you first. Every attempt is decided against those terms, every decision is written to a signed, hash-chained ledger, and revoking a mandate cuts the agent off instantly.

Think of it as a sanction letter for an agent, with the loan-book view to match.

## How agents connect

1. **One click, no secrets (MCP + OAuth 2.1).** Mandate is a remote MCP server and its own OAuth authorisation server. In Claude, ChatGPT, Cursor or any MCP client, add `https://your-mandate/api/mcp`; the agent sends the person to sign in and approve, and receives a scoped token. Tools: `list_mandates`, `check_mandate`, `request_purchase`. Scopes: `mandate:read`, `mandate:spend`. Client-ID metadata documents (CIMD) and RFC 7591 dynamic registration are both supported.
2. **API-key proxy (binding).** Store your OpenAI / Anthropic / Gemini keys encrypted; hand each agent a proxy key bound to a mandate; point the SDK's base URL at Mandate. Each call is priced from the request, pre-authorised, forwarded with the real key, and settled on reported usage, streaming included.
3. **Your own code (REST + mandate token).** `POST /api/agent/authorize` with a `Bearer mnd_…` token shown once at issue. `200` approved, `403` declined with the rule, `202` pending. Send `Idempotency-Key` on every attempt.
4. **Local stdio MCP** (`mcp/server.mjs`) wrapping the REST API for a single machine.
5. **Virtual cards (Stripe Issuing).** A card bound to a mandate, paid from a prepaid workspace balance (Stripe Checkout top-ups). Every card authorisation is decided in real time by the same policy engine plus a balance check; captures, reversals and refunds are reconciled; card details are shown through Stripe's Issuing Elements; freeze and cancel from the mandate page.

## Product surface

- **Front door**: public landing page, terms and privacy, a four-step onboarding on first sign-in; light and dark themes (follows the system, or pick one in the top bar — the wordmark turns orange in the dark).
- **Sign-in**: Google, passwordless email link, passkeys. No passwords.
- **Workspaces, members, roles**: every person gets a personal workspace; create more for a household or a team; invite by email as admin, approver or viewer; switch between workspaces from the top bar. Approvers decide requests but cannot issue mandates.
- **Exposure book**: sanctioned vs utilised per mandate, pending approvals, recent decisions with the actor (connected agent, token, proxy key, card).
- **Approval inbox**: every approver is notified through their own channels (email, or a webhook for n8n / Zapier / Make / your own service) with signed one-tap approve/deny links that confirm before deciding; unanswered requests expire after 24 h; allowances last 24 h; a denial blocks the same ask for 6 h.
- **API-key proxy**: see above; the `/proxy` page manages provider keys, proxy keys and shows every call with estimate vs settled cost.
- **Ledger and receipts**: append-only SHA-256 chain per workspace, verified incrementally; exports carry an Ed25519 signature over the chain head; a public verifier (`/api/receipts/verify`) and key (`/.well-known/mandate-receipt-key`) let anyone check a receipt; a printable receipt page per mandate.
- **Stats**: day / week / month / year spend, stacked by agent or merchant, by-agent and by-merchant shares, decisions per period with the rules that declined, a weekday × hour heat map, and a written reading of the numbers (trend, concentration, run-rate against sanctioned limits, idle mandates). Plain SVG, hover for exact figures, a table view for every chart.
- **Early warnings**: 80% of daily or total sanction, and unusual velocity, alert the approvers once per window.
- **Settings**: your channels, connected OAuth agents (disconnect = tokens revoked), passkeys, cardholder details for virtual cards, deployment capability status.
- **Hardening**: agents bound to the workspace they were consented into, with the member's live role re-checked on every call; idempotency keys reserved before deciding (concurrent retries collapse, *pending* is never replayed); Postgres-backed rate limits per token, key, address and auth endpoint; proxy endpoint allow-list and header allow-lists, with automatic key suspension on settlement overruns; webhook targets restricted to the public internet; receipts verified against the server key only; structured JSON logs with request ids; fail-closed card authorisations that answer Stripe before notifying anyone; provider keys encrypted with a key held outside the database; production refuses to start without its secrets.

## Run it locally

Requires Node 22+ (CI and the Docker image use 24) and Postgres 16 (or `docker compose up` for both).

```bash
cp .env.example .env            # set DATABASE_URL, BETTER_AUTH_SECRET, APP_URL
npm install
npm run db:migrate              # applies ./drizzle migrations
npm run dev                     # http://localhost:3000
```

Sign in with any email: without `RESEND_API_KEY`, the sign-in link is printed to the server console. Then `POST /api/dev/seed` (from the browser console while signed in: `fetch('/api/dev/seed',{method:'POST'})`; dev only) fills your workspace with two agents, two mandates and a few decisions.

```bash
npm test                            # policy-engine unit tests (pure)
npm run test:integration            # service layer against Postgres
npm run build && npm run test:e2e   # real browser + real HTTP through every flow (needs Playwright's Chromium)
npx tsc --noEmit
```

See `LAUNCH.md` for the step-by-step path to a public beta (accounts, secrets, Vercel + Neon + Resend, Google, monitoring, the pre-launch walkthrough) and `DEPLOY.md` for the reference on each piece, Stripe Issuing and Docker.

## What the test suite proves (all on Postgres 16, run in CI)

- **Unit (13)**: policy rule order, exact merchant matching, allowance binding and expiry, overnight hours, timezone-correct expiry, cooling-off, cap on open approvals, term validation; proxy endpoint allow-list, estimates for attachments / hidden history / `n` / snake_case configs, Gemini thinking tokens, private-address detection for webhooks.
- **Integration (13)**: hashed token lookup and revocation; ten concurrent requests never exceed a daily limit; pending → approve → allowance consumed exactly once under parallel retries; denial cooling-off; cards spend a prepaid balance (declined dry, API rail unaffected, idempotent top-up, hold, partial capture, refund, six concurrent authorisations never overspend); incremental and full chain verification with a valid signature, and rejection of a tampered head, a foreign workspace and a receipt carrying its own key; grouped exposure sums; rate-limit windows; encryption round-trip; proxy estimates and usage parsing for all three providers; twenty concurrent idempotency reservations yield one winner, pending releases, terminal answers replay; MCP grants bind and unbind with consent; partial card captures accumulate and uncaptured holds release.
- **End to end (38)**: landing; email-link sign-in; onboarding; seed decisions; inbox approval then agent retry by allowance; pending never replayed and approved replayed exactly under one `Idempotency-Key`; oversized amounts rejected; invitation → second browser accepts as approver → approver cannot issue and is turned away from `/mandates/new` with a reason → private webhook target refused; provider key stored → proxy key revealed once → metered call, streamed call, non-generation and traversal paths refused, unknown-key rejection; OAuth dynamic registration → consent (bound to the workspace) → PKCE token with scopes → MCP tools listed → purchase approved; cards via signed Stripe webhooks: declined with no balance, unsigned events rejected, Checkout top-up credited once, approved then declined at the balance, re-sent request answered identically, Stripe-side decline voids the hold, partial capture releases the rest, card reveal, balance and stats pages render (stats switches grain and shows a tooltip); signed receipt export; public verifier accepts it and rejects a tampered copy; OAuth discovery at the site root.

## Still open

- **Billing** (deliberately deferred): plans, limits and a billing page.
- **Stripe Issuing live**: the code is complete and exercised end to end with signed webhook events; going live needs the operator's Stripe account in the US, UK or EEA and Issuing approval (DEPLOY.md §5). Balance refunds are manual.
- **Proxy in non-USD mandates**: the price table is in USD; issue a USD mandate for proxy keys.
- **Magic-link sign-in mid-OAuth**: Google and passkey sign-ins resume an agent's connection automatically; after an email link the person clicks "connect" in the agent once more.
- **Notification channels are per person**, not per workspace; a workspace-level shared webhook is a natural next step.
- **Agents connected before this version** show as "not bound" in Settings; disconnect and connect them again once.

## Layout

```
app/                      pages, server actions, API routes
  api/auth/[...all]       Better Auth (sign-in, OAuth 2.1 server, passkeys)
  api/mcp                 remote MCP server (requireMcpAuth)
  api/proxy/[provider]    API-key proxy for OpenAI / Anthropic / Gemini
  api/agent/              token-based REST for your own agents
  api/webhooks/stripe     real-time card authorisation + reconciliation
  api/ledger/, api/receipts/   export, verify
  .well-known/            OAuth discovery and the receipt public key
  sign-in, consent, invite, members, workspaces, proxy, settings, docs, a/[id] (one-tap), terms, privacy
lib/auth.ts               Better Auth config (Google, magic link, passkey, orgs+roles, jwt, mcp, cimd)
lib/roles.ts              access control: owner, admin, approver, viewer
lib/schema.ts             Mandate tables (workspace-scoped, incl. mcp_grants); lib/auth-schema.ts generated auth tables (+ rate_limit)
lib/policy.ts             the decision engine (pure)
lib/service.ts            mandates, authorisation, approvals, exposure, reconciliation
lib/proxy.ts, pricing.ts  API-key proxy: keys, estimates, settlement; per-model prices
lib/ledger.ts, receipts.ts   per-workspace hash chain; Ed25519-signed receipts
lib/notify.ts, warnings.ts   email/webhook delivery, one-tap links; utilisation and velocity alerts
lib/ratelimit.ts, log.ts  Postgres rate limits; structured logs
drizzle/                  committed SQL migrations
tests/                    unit, integration, e2e
mcp/server.mjs            zero-dependency stdio MCP server
```

## Licence

MIT — see `LICENSE`. The hosted service at the operator's domain runs this same code; self-host it, fork it, or build on it.
