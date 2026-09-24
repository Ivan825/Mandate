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

Every non-approval also carries a **remedy** (`Remedy` in `lib/policy.ts`): when the same request would pass (`retryAt`), the largest amount that would pass right now (`maxAmountNow`), whether a human must act, and one sentence of advice. REST returns it as `remedy` and `x-mandate-retry-at`; MCP as part of the tool result; the proxy in the error message and `x-mandate-*` headers. An agent that reads it stops hammering.

`lib/service.ts` wraps it with the database: it loads facts inside a transaction with the mandate row locked, runs the engine, records the decision, consumes an approval if one applied, and schedules notifications after the response.

## Holds, capture and void

An approved decision is a **hold**, not a charge. The transaction row keeps `authorizedAmount` (what was approved) and `amount` (what counts against the limits right now), plus `settlement`: `held` → `captured` | `voided` | `released`. The agent captures what it actually paid (`POST /api/agent/capture`, `capture_purchase`) — less than authorised gives the difference back, more is refused — or voids the hold. Sums for the daily and lifetime limits always read `amount`, so nothing else in the engine had to change. Each mandate sets `holdTtlHours` (default 24; 0 = settle at once, the pre-0.4 behaviour) and `holdPolicy`: an unsettled hold is captured in full (safe default — the money probably moved and nobody said) or released. Expired holds are closed by `closeExpiredHolds`, which runs for the workspace on every authorisation, and across all workspaces from the health ping and the cron. The proxy settles its own holds on reported usage with a one-hour backstop; Stripe drives card holds through reconciliation; a simulation settles at once.

## Idempotency

Every decision path takes an idempotency key (`Idempotency-Key` header on REST; the tool call id on MCP; Stripe's event id for webhooks). `lib/idempotency.ts` **reserves** the key before deciding — a second request with the same key while the first is in flight gets a 409 with `retry-after`, not a second decision. Terminal answers (approved/declined) are stored and replayed byte-for-byte. A *pending* answer releases the reservation, so the agent's retry after approval is a real decision, which is what lets one approval be consumed exactly once even under parallel retries. Stale reservations are taken over after 60 s.

## Approvals

An escalation creates an approval row and notifies every approver in the workspace through the channels *they* chose (email, or a webhook). Links are signed with `NOTIFY_SECRET` and land on a confirm page, so a mail client's link preview can't approve anything. An approval is for one purchase of up to that amount at that merchant, valid 24 h; a denial blocks the same ask for 6 h; unanswered requests expire after 24 h. Approvers can decide but cannot issue mandates.

## The ledger and receipts

`lib/ledger.ts` appends one row per event (grant, decision, approval, revocation, top-up …) to a per-workspace chain: each row's hash covers the previous row's hash and the event payload. Verification is incremental from a checkpoint or full from genesis. Exports (`/api/ledger/export`) carry an Ed25519 signature over the chain head using `RECEIPT_SIGNING_KEY`; the public key is served at `/.well-known/mandate-receipt-key`, and `/api/receipts/verify` checks any receipt without a session — chain integrity, signature validity, and whether *this* server signed it. A receipt that carries its own public key is rejected: verification is always against the server's key.

## Pause, temporary raises and anomaly flags

A **pause** is `status = paused` with an optional `pausedUntil`; the engine declines with rule `paused` and a `retryAt`, and the mandate wakes itself on the next authorisation once the time passes (`expireStale` also writes the resume back). A **temporary raise** is a `mandate_overrides` row — one field, one amount, a window; `effectiveTerms()` reads the mandate's limits through any raise in force, only ever upward, so the issued terms recorded in the ledger stay true and the raise is its own ledger event. **Anomaly flags** (`lib/anomaly.ts`) are computed inside the authorisation transaction from the mandate's own recent history — unusual amount vs the median, first-time merchant, decline burst, rapid repeat — stored on the transaction and the approval row, and carried in the ledger payload, the inbox, the email, the push and the webhook. They never change a decision.

## Veto windows, plans, shadow mode, time-travel, autonomy

All five live in the same engine and the same tables, on purpose.

- **Veto** is a second escalation threshold below "ask me above". The engine answers `pending` with rule `veto`; the service writes an approval row of `kind = veto` with `vetoUntil`, and the agent is told to retry at that time. `expireStale` turns a veto row whose window closed into an ordinary allowance (`decidedBy = silence`), so the retry passes through the allowance path with rule `veto_passed`. Cancelling is a denial, with the usual cooling-off. The owner's inbox, email and push show "goes through at … unless you cancel".
- **Plans** are rows in `plans` with a JSON item list. `factsFor` loads the mandate's approved plans; the engine matches a request to the first unused item (merchant match, amount ≤ item) and answers `approved` with rule `plan` *before* escalation — the limits above it still apply. The service consumes the item under the plan's row lock and records the transaction id on it; a plan whose items are all used becomes `completed`. Items above the per-transaction limit are refused at proposal time: a plan cannot pre-approve what the terms forbid.
- **Shadow mode** is `mandates.mode = observe`: the service evaluates as usual, then, if the verdict was not `approved`, records it in `shadowDecision/shadowRule/shadowReason` and lets the request through with rule `observe`. No approval rows are written (nobody is asked). `shadowReport` aggregates the verdicts for the mandate page.
- **Time-travel** is `replayHistory()` in `lib/policy.ts`: the mandate's real requests (simulations excluded) are re-evaluated in order against hypothetical terms, with facts rebuilt from the replay's own approvals. Escalations stay `pending`. `/api/mandates/:id/replay` exposes it; the What-if panel on the mandate page drives it.
- **Graduated autonomy** keeps `autonomyLevel` and `autonomyStreak` on the mandate. `autonomyTick` runs inside the authorisation transaction: a clean enforced approval (no flags) advances the streak; reaching `autonomyEvery` raises the level by `autonomyStep` up to `autonomyCeiling − perTxnLimit`; a denial or a decline burst steps the level down. `effectiveTerms()` adds the level to the per-transaction limit and the ask-me-above threshold, so it composes with temporary raises. Steps are ledger events.

## Human-signed approvals

Approving from the inbox can be signed with the approver's passkey. `GET /api/approvals/:id/sign?d=approve` returns WebAuthn request options whose challenge encodes the approval id, the verdict, the user and a timestamp; the browser's `navigator.credentials.get()` signs it; `POST` verifies the assertion with `@simplewebauthn/server` against the passkey registered to the account (the same table Better Auth's sign-in uses), then decides with the assertion stored on the approval row and a digest of it in the ledger event. The transaction receipt carries the full assertion, and the receipt verifier re-checks it (`humanSignatureValid`). Nothing is trusted from the client: the challenge must decode to the decision it claims, the origin and RP id must match, and the key is the one on file.

## Public receipts

`shareTransaction` mints a share token (the capability) for one decision; `/r/:id?k=…` renders it and `/api/receipts/tx/:id?k=…` serves the signed JSON: the request and answer, the money lifecycle, the terms, the human approval, and the ledger rows that mention it with their hashes and the chain head. The signature is Ed25519 over `mandate-tx-receipt|<id>|sha256(canonical(core))|<signedAt>`, so the page's own JavaScript verifies it with WebCrypto against the key at `/.well-known/mandate-receipt-key` (or falls back to the server's verifier on browsers without Ed25519) — the page is not trusted, the bytes and the key are. Un-sharing clears the token and the link 404s.

## Push and the PWA

`public/sw.js` is a service worker that caches nothing; it exists to show push notifications with Approve / Deny actions. The action buttons call `POST /api/approvals/onetap/:id?d=…&t=…` with the same signed token the email links carry, so a decision from the lock screen has exactly the authority of a one-tap link and needs no cookie. Subscriptions live in `push_subscriptions` (per person, per device, max ten); `lib/push.ts` sends with VAPID via `web-push` and drops endpoints the browser reports gone.

## Activity feed and notes

`lib/activity.ts` reads the ledger as sentences: `describeEvent(type, payload)` gives every event a one-line summary, a group (decisions, approvals, mandates, cards …), a tone and the ids to filter by. `/activity` filters by kind, outcome, agent, mandate, date and free text (ILIKE over the canonical payload — adequate at beta scale; a tsvector column is the obvious upgrade), pages by ledger sequence, and lets members attach **notes** to a decision, an approval or an event. Notes are their own table, deliberately outside the hash chain: the chain records what happened, notes record what people think about it. The same `describeEvent` summary goes into webhook envelopes, so a Slack message built from a webhook reads exactly like the feed.

## Event webhooks

`lib/webhooks.ts`. A workspace registers up to ten endpoints, each with an event filter (`*`, or prefixes such as `authorization.`) and its own `whsec_` secret (stored encrypted, shown once, rotatable). `ledger.appendEvent` queues one `webhook_deliveries` row per matching endpoint **inside the same transaction** as the ledger row, so an event can never be announced before it exists or exist without being announced. Sending is decoupled: `kick()` runs a dispatch pass after the response (`after()` on Next), and `dispatchDue()` — claim with `FOR UPDATE SKIP LOCKED`, send, record — is also run by the health endpoint, the daily cron and `GET /api/cron/dispatch`, so retries need no worker process. Each envelope carries the ledger `seq` and `hash`, a stable `evt_` id (identical across endpoints, for de-duplication) and the human summary; it is signed Stripe-style (`Mandate-Signature: t=…,v1=HMAC-SHA256(secret, "t.body")`) over the exact bytes sent. Failures back off 1 m → 5 m → 30 m → 2 h → 12 h; an endpoint that fails 25 deliveries in a row is paused and the pause is itself a ledger event. Deliveries to one endpoint go out in ledger order. Targets must resolve to public addresses (same SSRF guard as notification channels) unless the operator sets `WEBHOOK_ALLOW_PRIVATE=1`.

## Money and currencies

Amounts are integers in each currency's minor unit; `lib/money.ts` is the only place that knows that yen have no decimals and dinars have three. Every form converts through it, `fmt` formats in a locale that suits the currency (₹1,00,000), and a workspace carries a default currency for new mandates (`workspace_settings`). Nothing is ever converted between currencies: a mandate is denominated once, and the stats page shows one currency at a time.

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
