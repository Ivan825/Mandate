# Testing

Three suites, all run in CI on every push and pull request against a real Postgres 16.

```bash
npm test                      # unit — the policy engine and proxy logic, no database
npm run test:integration      # service layer against Postgres
npm run build && npm run test:e2e   # a real browser and real HTTP through every flow
npx tsc --noEmit              # types
```

The end-to-end suite starts the production build on a spare port, signs in through the console-printed magic link, and drives Playwright's Chromium. Set `PW_CHROMIUM=/path/to/chrome` to use a specific binary.

## Unit (19)

Policy rule order; exact merchant matching and wildcards; allowance binding and expiry; overnight active hours; timezone-correct expiry; denial cooling-off; the cap on open approvals; term validation; every non-approval carries a remedy with a correct `retryAt` (next window in a half-hour timezone, next local midnight, end of cooling-off) and `maxAmountNow` bound by whichever limit binds first; a pause declines with a resume time and lifts itself, a raise lifts one limit only while in force and only upward; veto windows (pending with no human required, matured windows pass, cancellation blocks, asking wins above its threshold, validation); plan items pass once within the limits; graduated autonomy lifts per-transaction and ask-me-above up to the ceiling; time-travel replays history against tighter terms and counts what changes. Proxy: endpoint allow-list, cost estimates for attachments, hidden history, `n`, snake_case configs and Gemini thinking tokens; private-address detection for webhook targets including IPv4-mapped IPv6, 6to4 and NAT64.

## Integration (24)

- Hashed token lookup and revocation.
- Ten concurrent requests never exceed a daily limit.
- Pending → approve → allowance consumed exactly once under parallel retries; denial cooling-off.
- Cards spend a prepaid balance: declined when dry, the API rail unaffected, idempotent top-ups, holds, partial capture, refund; six concurrent authorisations never overspend.
- Ledger: incremental and full chain verification with a valid signature; rejection of a tampered head, a foreign workspace, and a receipt carrying its own key.
- Grouped exposure sums; rate-limit windows; encryption round-trip.
- Proxy estimates and usage parsing for OpenAI, Anthropic and Gemini.
- Twenty concurrent idempotency reservations yield one winner; pending releases; terminal answers replay.
- MCP grants bind and unbind with consent; partial card captures accumulate and uncaptured holds release.
- Holds: approve → capture less releases the difference; void releases all; a second capture and an over-capture are refused; another mandate's token cannot touch the hold; expired holds close by policy (capture in full vs release); a zero-TTL mandate settles at once.
- Event webhooks: a private target is refused unless allowed; deliveries queue in the ledger's transaction, honour the event filter, arrive at a local receiver with a signature that verifies (and fails with the wrong secret); failures back off and 25 in a row pause the endpoint.
- Pause freezes the token and auto-resumes; raises lift a limit, are refused below the base, and can be withdrawn; every step is a ledger event.
- Anomaly flags: unusual amount, new merchant, decline burst and rapid repeat computed from history, stored on the transaction and on the approval row.
- Veto window end to end: pending with `retryAt`, same ask deduplicated, maturity into a `silence` allowance, `veto_passed`, cancellation cooling-off, asking above its own threshold.
- Plans: over-limit items refused at proposal; unapproved plan changes nothing; approved items pass once with rule `plan` and record the transaction id; all items used → `completed`.
- Shadow mode: nothing declined, verdicts recorded and reported, no approval rows written, enforcement resumes on switch.
- Graduated autonomy: three clean decisions raise the level; lifted threshold and per-transaction limit observed; ceiling respected; a denial steps back.
- Human-signed approval with a real ES256 assertion built from a generated P-256 key registered as a passkey: a challenge for the wrong verdict is refused, the right one verifies (alg −7), the signature is stored, the ledger event carries the digest, and the stored assertion re-verifies while a tampered one does not.
- Activity feed: events read as sentences with the agent's name; filters by group, outcome and mandate; free-text search; notes attach to a decision.

## End to end (92)

Landing renders; email-link sign-in; onboarding; seeded decisions; inbox approval then agent retry by allowance; *pending* never replayed and *approved* replayed exactly under one `Idempotency-Key`; oversized amounts rejected; the approved answer is a hold with an expiry → captured for less over REST (difference released) → a second capture refused with the current state → state readable by the agent → another mandate's token gets 404; declines carry remedies (`maxAmountNow`, allowed merchants); the agent's mandate view lists its open holds; the mandate page shows held and captured pills; the activity feed renders sentences, takes a note, and filters; the event-webhooks page renders and refuses a private target; a mandate is paused from its page and the API declines with `paused`, then resumed; a temporary raise lets a larger purchase through; a decision is shared and its public receipt page renders, its JSON verifies through the server verifier, and un-sharing 404s it; the template picker pre-fills the form; the connect wizard renders every rail; a push subscription registers and lists (with fake VAPID keys); the signed one-tap API decides an approval from the email link; a veto-window mandate answers pending with a retry time and the inbox shows it under "going through unless you cancel"; a plan proposed over REST appears in the inbox and, once approved there, its item passes with rule `plan`; shadow mode lets an out-of-scope request through and the mandate page reports it; the what-if replay API counts changed decisions; the signing endpoint answers 412 for a user without a passkey; the plan one-tap page renders; invitation accepted in a second browser as approver → the approver cannot issue and is turned away from `/mandates/new` with a reason; a private webhook target is refused; provider key stored → proxy key revealed once → metered call, streamed call, non-generation and traversal paths refused, unknown-key rejection; OAuth dynamic registration → consent bound to the workspace → PKCE token with scopes → MCP tools listed → purchase approved; cards through signed Stripe webhook events: declined with no balance, unsigned events rejected, a Checkout top-up credited once, approved then declined at the balance, a re-sent request answered identically, a Stripe-side decline voiding the hold, partial capture releasing the rest, card reveal; balance and stats pages render and the stats page switches grain and shows a tooltip; signed receipt export; the public verifier accepts it and rejects a tampered copy; OAuth discovery at the issuer path and at the bare well-known root.

## What is not automated

The real Claude Desktop connector (CIMD → consent → tools) was verified by hand against the hosted beta and is exercised in CI only through a simulated client. Stripe Issuing runs against signed fake events, not Stripe's servers — going live needs a real Issuing-approved account and a manual pass through `DEPLOY.md` §5.
