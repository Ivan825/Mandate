# Testing

Three suites, all run in CI on every push and pull request against a real Postgres 16.

```bash
npm test                      # unit — the policy engine and proxy logic, no database
npm run test:integration      # service layer against Postgres
npm run build && npm run test:e2e   # a real browser and real HTTP through every flow
npx tsc --noEmit              # types
```

The end-to-end suite starts the production build on a spare port, signs in through the console-printed magic link, and drives Playwright's Chromium. Set `PW_CHROMIUM=/path/to/chrome` to use a specific binary.

## Unit (13)

Policy rule order; exact merchant matching and wildcards; allowance binding and expiry; overnight active hours; timezone-correct expiry; denial cooling-off; the cap on open approvals; term validation. Proxy: endpoint allow-list, cost estimates for attachments, hidden history, `n`, snake_case configs and Gemini thinking tokens; private-address detection for webhook targets including IPv4-mapped IPv6, 6to4 and NAT64.

## Integration (13)

- Hashed token lookup and revocation.
- Ten concurrent requests never exceed a daily limit.
- Pending → approve → allowance consumed exactly once under parallel retries; denial cooling-off.
- Cards spend a prepaid balance: declined when dry, the API rail unaffected, idempotent top-ups, holds, partial capture, refund; six concurrent authorisations never overspend.
- Ledger: incremental and full chain verification with a valid signature; rejection of a tampered head, a foreign workspace, and a receipt carrying its own key.
- Grouped exposure sums; rate-limit windows; encryption round-trip.
- Proxy estimates and usage parsing for OpenAI, Anthropic and Gemini.
- Twenty concurrent idempotency reservations yield one winner; pending releases; terminal answers replay.
- MCP grants bind and unbind with consent; partial card captures accumulate and uncaptured holds release.

## End to end (40)

Landing renders; email-link sign-in; onboarding; seeded decisions; inbox approval then agent retry by allowance; *pending* never replayed and *approved* replayed exactly under one `Idempotency-Key`; oversized amounts rejected; invitation accepted in a second browser as approver → the approver cannot issue and is turned away from `/mandates/new` with a reason; a private webhook target is refused; provider key stored → proxy key revealed once → metered call, streamed call, non-generation and traversal paths refused, unknown-key rejection; OAuth dynamic registration → consent bound to the workspace → PKCE token with scopes → MCP tools listed → purchase approved; cards through signed Stripe webhook events: declined with no balance, unsigned events rejected, a Checkout top-up credited once, approved then declined at the balance, a re-sent request answered identically, a Stripe-side decline voiding the hold, partial capture releasing the rest, card reveal; balance and stats pages render and the stats page switches grain and shows a tooltip; signed receipt export; the public verifier accepts it and rejects a tampered copy; OAuth discovery at the issuer path and at the bare well-known root.

## What is not automated

The real Claude Desktop connector (CIMD → consent → tools) was verified by hand against the hosted beta and is exercised in CI only through a simulated client. Stripe Issuing runs against signed fake events, not Stripe's servers — going live needs a real Issuing-approved account and a manual pass through `DEPLOY.md` §5.
