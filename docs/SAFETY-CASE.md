# Safety case

*What Mandate stops, how we know, and what it does not stop. The irreversible action it guards against is money leaving an account on an agent's say-so.*

## 1. The claim

An AI agent connected through Mandate cannot spend outside the terms a person set, cannot spend what it has not been granted, cannot undo the record of what it did, and can be stopped — all of it, every rail — with one button. It gets a *mandate* instead of a card: a per-transaction, daily and total limit, a merchant list, hours, an expiry, and an amount above which a human must approve first. Everything the agent could use to pay — a REST token, an MCP tool, an LLM-API proxy key, a virtual card — is decided by the same policy engine before the money moves.

The safeguard sits **before** the irreversible step, not after. A declined request never reaches the merchant; a request that needs a human waits as a *hold* until someone taps approve, and a later refusal is still in time.

## 2. How it prevents the action (safety effectiveness)

Every request, from any rail, goes through one function (`lib/policy.ts` → `authorize()` in `lib/service.ts`) that decides in a fixed order: **frozen** (the panic button), paused, revoked/expired, hours, merchant, category, per-transaction, daily, total, prepaid balance, every ancestor's limits (for sub-mandates), then escalation to a human. Six of these are *hard rules* that no mode, override or allowance can relax.

What that gives you, concretely:

- **Bounded blast radius.** The worst an agent with a $50/txn, $150/day mandate can do is $150 today, at the merchants listed, during the hours listed. Not "whatever is on the card."
- **A human in the loop where it matters.** Above the ask-me threshold the agent gets `202 pending` and a one-tap link goes to the approvers (email, push, webhook). An approval is an *allowance* for that exact amount at that exact merchant, consumed once. Large amounts can require 2–5 distinct approvers (co-signing), and approvals can be passkey-signed so a receipt proves a person on a registered device decided.
- **Delegation that cannot widen.** An agent may carve a *sub-mandate* for a helper, but only inside its own terms; the family's spend counts against every ancestor; revoking the parent revokes the children.
- **The panic button.** Two clicks freeze the workspace: every rail declines until unfrozen, nothing is deleted, and the engine checks it before it even loads the mandate.
- **Holds, not charges.** An approval authorises; the agent then captures for at most that amount, or the hold expires and closes by the mandate's policy. Vouchers let a merchant redeem a hold without an account, once, for at most what was authorised — and once a voucher is out the agent can no longer close the hold itself.
- **A record nobody can quietly edit.** Every decision is a row in a hash-chained ledger; the head is signed daily into a public anchor chain (`/anchors`), so even the operator cannot rewrite history without it showing. Receipts verify offline against the published key.

## 3. How it was tested (testing and robustness)

Three suites run in CI on every push (`.github/workflows/ci.yml`):

| Suite | Count | What it exercises |
|---|---|---|
| `npm test` | 22 | The policy engine in isolation: rule order, hours across timezones, expiry at end of local day, cooling-off after denial, the panic button beating a valid allowance, sub-mandates inside every ancestor |
| `npm run test:integration` | 41 | The service layer against real Postgres: concurrent requests never exceed the daily limit, idempotent retries, holds and captures, disputes, vouchers, anchors, routing, plus eight *hardening* tests written during the security audit |
| `npm run test:e2e` | 136 | A real browser and real HTTP through every flow: sign-in, seed, approve from the inbox, one-tap links, MCP over OAuth, the LLM proxy against a stub upstream, Stripe webhooks with locally signed events, the panic button, delegation, vouchers, disputes |

A fourth suite, `npm run redteam`, plays an adversarial agent against a running instance over plain HTTP — the same calls a real agent makes — and writes its results to [`RED-TEAM.md`](RED-TEAM.md): **55 attempts, 55 stopped**, alongside 8 legitimate controls that go through, so the safeguard is shown to discriminate rather than to block everything. The groups: limits and scope, malformed input, escalation and approval links, holds and vouchers, delegation, idempotency and replay, tokens, the panic button, and the ledger.

The bypass attempts pinned by the test suites, and what happens:

- A second mandate's token trying to void the first mandate's hold → `404` (the row is invisible, not just forbidden).
- An agent trying to void a card hold, a proxy hold, or a hold whose voucher has been issued → `409`.
- A forged one-tap token, a replayed one, or one used after the recipient lost their role → `403` / `409`; the page reveals nothing about the request without a valid token.
- Two sign-offs from the same account under different e-mail spellings → counted once. An anonymous link on a multi-approver request → refused.
- The same `Idempotency-Key` with a different purchase → `422`, never the cached answer.
- A tampered voucher → invalid. A voucher redeemed twice → `409`. Redeemed for more than authorised → refused.
- A sub-mandate with limits above its parent's → `400` with field errors.
- Observe ("shadow") mode never lifts the freeze, a pause, revocation, expiry or the balance.
- A webhook, notification hook or proxy target pointing at a private address or cloud metadata, including via a DNS name that resolves there → refused at connect time, not just at creation.
- A generic-proxy path that escapes its target's base (`../../admin`) → refused.
- An anchor or receipt signed under a key that is neither current nor listed as retired → verification failure, not a footnote.
- Twenty concurrent requests against a daily limit → the limit holds (row locks on the mandate and its ancestors).

The full review — threat model, every finding, every fix — is [`SECURITY-AUDIT.md`](SECURITY-AUDIT.md). Dependencies: `npm audit` reports only dev-time (`drizzle-kit → esbuild`) advisories.

## 4. Why this problem (real-world relevance)

Agents are starting to buy things — API credits, SaaS seats, ads, goods — and today the only way to let one do that is to hand it a card or a provider key. That is unlimited, unlogged, and irreversible. Spend caps on the provider side cap one vendor; they do not say *which* purchases, do not ask a human, do not cover the next vendor, and do not produce a record you could show an auditor. Mandate is the thing in between: an agent's authority to spend, as a first-class object a person issues, narrows, shares and revokes.

It is live at [mandate-ashen.vercel.app](https://mandate-ashen.vercel.app) with Claude (MCP/OAuth), OpenAI/Anthropic/Gemini SDKs (proxy base URL), any REST client, and Python/TypeScript SDKs.

## 5. Reproducing it (reproducibility and reuse)

```bash
git clone https://github.com/Ivan825/Mandate && cd Mandate
docker compose up          # Postgres + the app on :3000, migrations applied
# sign in with any email (the link prints to the terminal), then in the browser console:
#   fetch('/api/dev/seed', {method:'POST'})   → a workspace with agents, mandates, decisions and a pending approval
npm test && npm run test:integration && npm run build && npm run test:e2e
npm run redteam            # the adversarial run; prints a table and the tally
```

Everything is AGPL-3.0. The policy engine (`lib/policy.ts`) is a pure function of (mandate, request, facts) and can be lifted into another system on its own; the MCP server, the proxy and the SDKs are each independent entry points to the same `authorize()`.

## 6. What it does not do (limitations)

- **It governs money that flows through it.** A card or key the agent already holds is outside its reach. Adoption is the safeguard; Mandate cannot retroactively fence an agent that was never pointed at it.
- **It enforces terms, it does not judge intent.** A purchase within limits, at an allowed merchant, during allowed hours goes through. Whether it was a *sensible* purchase is the owner's job when setting the terms and the approver's job when a request escalates. Anomaly flags (unusual amount, new merchant, decline bursts, rapid repeats) surface oddities; they do not block.
- **Approvals are only as good as the approver.** A one-tap link can be tapped without reading. Co-signing and passkey signing raise the bar; they do not remove it.
- **The operator is trusted for confidentiality.** Provider keys are encrypted under a key the operator holds; public anchoring makes a rewritten ledger *detectable*, not impossible. A KMS-backed envelope scheme and in-place key rotation are the next step and are not built.
- **Virtual cards need Stripe Issuing approval** on the operator's account; the code is complete and tested with signed events, but the hosted beta runs without the card rail.
- **Single deployment, free tiers.** The hosted beta runs on Vercel and Neon free plans; it has gone down once from exhausting the database's monthly compute, which is a reliability limitation, not a safety one (a down Mandate fails *closed*: nothing can be authorised).
- Smaller open items from the audit: the passkey challenge carries the approver's account id in clear; the rate limiter fails open if Postgres is down; the CSP still allows inline scripts (Next injects them without nonces); the LLM price table is hand-maintained (unknown models are priced at the family maximum, which over-reserves rather than under).
