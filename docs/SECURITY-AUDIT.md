# Security audit — 0.7.1

*Scope: the whole application as of 0.7.0 (every rail, every connection, every piece of stored data). Method: four independent review passes over the code (authorisation and money movement; identity, sessions and links; network egress and the proxies; storage, receipts and the ledger), each finding reproduced in a test before it was fixed. This document is the record: what Mandate holds, who can reach it, what was wrong, what changed, and what is still open.*

Read this alongside `SECURITY.md` (how to report) and `DEPLOY.md §7` (what the deployment locks down).

## 1. What Mandate holds, and why it matters

Mandate sits between agents and money. A breach is not a leaked password list; it is an agent spending outside its terms, an approval consumed twice, a stranger settling a hold, or a stored credential read back. So the data model is judged by what an attacker could *do* with each row, not only by whether it is personal.

| Data | Where | Protection at rest | Who can read it |
|---|---|---|---|
| Mandate tokens (`mnd_…`) | `mandates.token_hash` (SHA-256), `token_reveal` (show-once, encrypted, swept) | hashed; reveal is AES-256-GCM and deleted on first view or by the sweeper | nobody after issue; the agent holds the only copy |
| Proxy keys (`mpx_…`) | `proxy_keys.token_hash` / `token_reveal` | same as above | same |
| Provider API keys (OpenAI, Anthropic, Gemini) | `provider_keys.ciphertext` + 4-char hint | AES-256-GCM under `MANDATE_ENCRYPTION_KEY` (16-byte tag, pinned) | decrypted only inside the proxy request, never returned to a browser or an agent |
| Generic-target credentials | `proxy_targets.auth_ciphertext` + hint | same | same |
| Webhook signing secrets | `webhook_endpoints.secret_ciphertext` | same | shown once at creation |
| Approvals, decisions, holds, disputes, plans, routes | their tables | Postgres; TLS-verified connection | workspace members by role; agents see their own mandate only |
| Ledger (hash chain) + anchors | `ledger`, `ledger_heads`, `ledger_anchors` | chained SHA-256, Ed25519-signed heads and anchors | members; anchors are public by design (workspace named by a hash) |
| Passkeys | Better Auth `passkey` table (public key + counter) | public material only | the owner, for signing |
| Sessions, OAuth grants, MCP consents | Better Auth tables, `mcp_grants` | httpOnly cookies, JWTs, revocable | — |
| Notification channels, push subscriptions | `notification_channels`, `push_subscriptions` | plain (endpoints, addresses) | the user; export includes them |
| Card programme (Stripe Issuing) | `cardholder_profiles` (Stripe ids), `topups`, `stripe_events` | Stripe holds the PAN; we hold ids | owners/admins; card numbers only via Stripe's ephemeral-key flow in the browser |

Every table with a `workspace_id` cascades on workspace deletion. Account deletion purges sole-owned workspaces, tombstones their anchors (`workspace_id = "deleted"`) so the public chain stays intact, and settles open holds first.

## 2. Who can reach what

Five kinds of principal touch the system. Each gets exactly one path in.

**People** sign in with a magic link, Google, or a passkey; the session cookie is httpOnly, SameSite=Lax. Roles are owner, admin, approver, viewer; every mutating page action re-checks the role through Better Auth's access control, every API route through `can()`. State-changing cookie-authenticated JSON routes (`push/subscribe`, `mandates/:id/replay`, `cards/:id/ephemeral-key`, `approvals/:id/sign`, `dev/seed`) additionally refuse requests whose `Origin`/`Sec-Fetch-Site` say they came from another site.

**Agents over REST** present a mandate token. `authenticateMandate()` hashes it, refuses revoked or expired mandates (except on the capture/void/transactions/mandate routes, which must still work to close a dying mandate's holds), and never lets a token see another mandate's rows: every query is scoped by `mandate_id`, and the cross-mandate probes in the e2e suite return 404, not 403.

**Agents over MCP** hold an OAuth grant bound at consent to one workspace and one client. Each call re-reads the member's current role and refuses grants withdrawn in Settings even before the JWT expires. Delegations record `delegated_by = mcp:<user>:<client>` so disconnecting the client revokes the helpers it created.

**Merchants** present a voucher (`mv1.…`, Ed25519 over the payload). No account, no cookie: the signature is the capability, and it is checked against *this server's* key (or a listed retired key), never a key inside the voucher. A voucher redeems once, for at most the authorised amount, at the merchant it names, and only for API/MCP holds (card and proxy holds are settled by the card network and the proxy).

**One-tap links** (email, webhook, push) carry an HMAC over `approval id | decision | expiry | recipient user id` under `NOTIFY_SECRET`. The page shows *nothing* about the request without a valid link; a valid link still re-checks that the recipient is a current member who may decide; a request that needs several named approvers refuses anonymous links outright.

**Cron and health** use `CRON_SECRET` compared in constant time.

## 3. What the review found and what changed

Ordered by what an attacker could have done. Every item below has a regression test in `tests/service.test.ts` ("hardening: …"), `tests/e2e.mjs`, or `tests/proxy.test.ts`.

### 3.1 Money movement

**An agent could settle holds it did not own the outcome of.** `POST /api/agent/void` accepted any open hold under the mandate, including card holds (settled by Stripe) and proxy holds (settled by the proxy after the upstream call). Voiding one freed the limits and the prepaid balance for money that still moved. *Fixed:* `settleProblem()` — the agent scope may settle only its own API/MCP holds while they are open and before a voucher is out; the owner may settle API and proxy holds; nobody settles card holds by hand.

**Observe (shadow) mode overrode the hard rules.** A mandate switched to observe let requests through that the workspace freeze, a pause, revocation, expiry, the balance, or a malformed amount should have stopped. *Fixed:* `HARD_RULES = amount, frozen, paused, status, expiry, balance` plus every `parent_*` rule are enforced in every mode; observe mode only relaxes merchant, category, limits and escalation, and records what it would have done.

**Co-signatures were counted by e-mail spelling.** Two sign-offs from the same person under `alice@` and `Alice@` were rejected, but `alice+work@` was not; and a one-tap link with no account could count as a named approver. *Fixed:* sign-offs record `userId`; deduplication is by account; anonymous links are refused for multi-approver requests (`anonymous: true`, HTTP 403); one-tap tokens are bound to their recipient and re-check membership on use.

**Vouchers rode along in the authorisation answer.** Every approved hold's JSON carried a voucher, so any log line or tool trace containing the answer was a redeemable instrument, and the agent could still void the hold after handing the voucher over. *Fixed:* the answer carries `voucherUrl`; fetching it (`GET /api/agent/transactions/:id/voucher`, MCP `get_voucher`, SDK `voucher()`) sets `voucher_issued_at`, after which capture/void by the agent is refused (409). Vouchers are never issued for sandbox, card, proxy or dispute rows, and must be redeemed at the merchant they name.

**Idempotency keys replayed across different purchases.** The same `Idempotency-Key` with a different body returned the cached answer for the first body. *Fixed:* `idempotency_keys.request_hash` (SHA-256 of the body); a mismatch is HTTP 422, not a replay. REST refuses keys in the `mcp:` namespace so the two channels cannot collide.

**Stripe incremental authorisations were approved without the engine.** *Fixed:* `incrementCardHold()` runs the full policy check on the increment; events are deduplicated atomically (`stripe_events` insert-or-ignore), `stripe_authorization_id` is unique, and an over-capture raises a warning event.

**Disputes could refund more than was captured.** *Fixed:* refunds are `min(dispute, transaction)` net of prior refunds, dated at the original decision so the daily books stay honest; card-source rows cannot be marked refunded (Stripe does that); pausing on dispute needs `mandate:revoke`, refunding needs `mandate:issue`.

**Numbers the ledger cannot hold.** Route bands, target prices, raises and form fields accepted floats, negatives, `Infinity`, and values above int4. *Fixed:* `MAX_AMOUNT` (2,147,483,647 minor units) is enforced in `createMandate`, `raiseLimit`, `addRoute`, `addTarget`, `delegate`, the MCP tools and the form parser; hours are capped so no `Invalid Date` reaches the database; a workspace holds at most 50 routes; a mandate at most 10 children, 3 deep; delegation is rate-limited (20/min per parent).

**Plans pre-approved wildcards.** A plan item `Vercel*` would have let any merchant starting with "Vercel" through once. *Fixed:* plan items name exact merchants.

### 3.2 Network egress (SSRF)

Mandate makes outbound requests to four kinds of address an end user controls: event webhooks, notification webhooks, generic proxy targets, and Web Push endpoints. Before this pass the check was on the hostname string at creation time; a DNS name that later resolved to `169.254.169.254` or `10.0.0.1` was fetched.

*Fixed:* `lib/net.ts` (private + metadata block lists) and `lib/safe-fetch.ts` — an undici `Agent` whose DNS lookup is guarded, so the address actually connected to is the one that was checked (no rebinding window); literal IPs are checked up front; redirects are not followed; every read is capped (`readCapped`) and timed out. `WEBHOOK_ALLOW_PRIVATE=1` and `PROXY_TARGET_ALLOW_PRIVATE=1` lift the private-range block for self-hosters on their own network; the cloud-metadata ranges are blocked regardless. Push endpoints are allow-listed to the browser vendors' push services (`PUSH_EXTRA_HOSTS` for others).

**The generic proxy could escape its target's base path.** `/api/proxy/t/<slug>/../../admin` reached outside the configured base. *Fixed:* segments are validated (`badSegment`), the resolved URL must stay under the base, and the body forwarded is bounded (20 MB response cap, 120 s timeout).

### 3.3 The LLM proxy

**The body forwarded was not the body priced.** The raw request text went upstream while the estimate was made from the parsed JSON; a body with duplicate keys could name one model to us and another to the provider. *Fixed:* the parsed object is re-serialised and that is what is sent.

**Long streams lost the usage frame.** The settlement buffer kept the first 2 MB of a stream; the usage frame is the *last* thing a provider sends. *Fixed:* a rolling tail buffer; and a stream the client aborts settles at `max(reported, estimate)`, since a partial stream cannot prove it cost less.

**Model prices matched too loosely.** `gpt-5-pro` was priced as `gpt-5`, `o3-pro` as `o3`. *Fixed:* a prefix match is accepted only when what follows is a version suffix (a date, `-latest`, `-preview`, `-exp`, a build number); anything else is priced at the family maximum. Entries added for the `-pro`, `o1`, `o3-mini`, deep-research and `claude-opus-4-5` models.

### 3.4 Identity, links, sessions

- One-tap tokens name their recipient (`exp.u<user>.sig`); `linkPrincipal()` re-checks role on use; the `/a/:id` and `/p/:id` pages render nothing without a valid token (previously they showed the amount, merchant and agent to anyone with the id).
- Passkey challenges dated in the future are refused (they could not be ours); the stored human signature on a receipt is re-verified *and* checked to commit to that approval and that verdict, so a valid signature from another decision cannot be pasted in.
- `next=` redirects go through `safeNext()` (same-origin paths only).
- Cookie-authenticated JSON routes that change state refuse cross-site origins (see §2).
- Better Auth's organisation-delete endpoint is disabled (`disableOrganizationDeletion`); the only way to delete a workspace is the account page, which settles holds and tombstones anchors first.
- The activity feed escapes `LIKE` metacharacters *after* truncation and matches ids only when they look like ids.

### 3.5 Receipts, ledger, anchors

**Receipts named people.** A shared transaction receipt carried the approver's e-mail, their account id, the actor string and the raw workspace id, and its event list was selected by a `LIKE` over any id in the payload — which pulled in rows about *other* decisions. *Fixed:* `redactPerson()` turns every address into `a…@domain`, `userId`/`authorId` are dropped from payloads and the human signature, the workspace appears as its public anchor label, and only rows about this transaction and its approval are included (receipt-level and dispute rows excluded). The row hashes shown are the ledger's own; a reader compares them with the workspace chain.

**Anchor verification trusted unknown keys.** `verifyAnchors()` skipped the signature of any anchor whose `key_id` was not the current key — a forged anchor under an invented key id would have passed as "signed before a rotation". *Fixed:* `RECEIPT_PREVIOUS_PUBLIC_KEYS` lists retired public keys (PEM or raw base64); an anchor or receipt verifies only under the current key or a listed retired one, and any other key is reported as a break (`Signed with an unknown key …`). `/.well-known/mandate-receipt-key` advertises retired key ids (`?all=1` for the full list); `/api/ledger/anchors` includes `previousKeys`. The public verifier is cached per instance for a minute so anonymous readers cannot make the database re-walk the chain per request; `?label=` filters in SQL.

**The public receipt verifier was unbounded.** *Fixed:* 5 MB body cap, 20 000-event cap, 30 requests/min per address; voucher verify/redeem bodies capped at 16 KB.

### 3.6 Operations

- **Mail never silently prints.** In production, with no SMTP/Resend transport, sending a message throws instead of writing a sign-in link to the log — `EMAIL_CONSOLE=1` opts back in for tests.
- **Forwarding headers are trusted only when something trustworthy sets them**: on Vercel, or with `TRUST_PROXY=true` behind your own reverse proxy. Anywhere else every client shares one rate-limit bucket rather than choosing its own address. (`TRUST_PROXY=false` still forces the shared bucket.)
- Cron and health endpoints compare secrets in constant time; health housekeeping is throttled to once a minute; the cleanup cron prunes OAuth tokens, proxy call logs, dead push subscriptions and swept reveals.
- `Referrer-Policy: no-referrer` and `Cache-Control: no-store` on `/a`, `/p`, `/r` so a signed link never leaks through a referrer or a shared cache.
- AES-GCM decryption pins the 16-byte auth tag length.
- Account export (`GET /api/account/export`) now includes every table that mentions the user or their workspaces — settings, overrides, routes, plans, disputes, notes, top-ups, proxy calls, webhooks, cardholder ids, anchors — with every secret column (token hashes and reveals, ciphertexts) stripped.

## 4. Verified clean

Checked and found sound, so they are recorded here to save the next reviewer the trip:

- Every SQL statement goes through Drizzle's parameterised builder; the only raw fragments are `sql\`\`` templates with bound parameters.
- No token is ever stored in plaintext; lookups are by hash; reveals are encrypted, shown once, and swept.
- The ledger cannot be edited in place without breaking `verifyChain()`; anchors make a rebuilt chain detectable from outside.
- Stripe webhooks are signature-verified and deduplicated before any state changes.
- Rate limits live in Postgres and hold across serverless instances; the limiter fails open only if the *database* is down, in which case nothing else works either.
- `npm audit`: 4 moderate advisories, all in `drizzle-kit → esbuild` (development-only; not shipped).
- Concurrency: authorisations lock the mandate row and its ancestors in a transaction; the "concurrent requests never exceed the daily limit" test still passes with the family locks.

## 5. Still open

Known, accepted for now, and worth revisiting:

- **Passkey challenge is the user id in clear.** The signed WebAuthn challenge encodes `approvalId.decision.userId.ts.nonce`; a public receipt therefore contains the approver's *account id* inside the challenge even though the field itself is dropped. It is a random identifier, not personal data, but a future version should hash it in the challenge.
- **Rate limiter fails open** when Postgres errors on the counter. Acceptable (nothing else works either), but a per-instance in-memory fallback would be stricter.
- **Passkey challenges are single-use only per instance.** Structural checks (decision, user, freshness) hold across instances; a challenge could be reused across two instances within five minutes, but the approval it commits to can only be decided once, so the effect is nil.
- **`TRUST_PROXY` on bare Node without a proxy** is now a shared bucket by default. Self-hosters behind nginx/Caddy must set `TRUST_PROXY=true` (documented in `.env.example` and `DEPLOY.md`).
- **Provider price table is hand-maintained.** Unknown models are priced at the family maximum, which is safe but can over-reserve; review `lib/pricing.ts` when providers ship new tiers.
- **No content-security-policy header yet.** Pages inline no third-party scripts, so the exposure is low, but a strict CSP is the right next step.

## 6. How to re-run this audit

```
npm test                      # policy engine, proxy pricing/usage, SSRF unit checks
npm run test:integration      # 41 tests incl. every "hardening: …" regression (needs DATABASE_URL)
npm run build
PW_CHROMIUM=<chromium> npm run test:e2e   # 136 browser + API checks incl. forged links, path escape, idempotency mismatch
cd sdk/typescript && npm test; cd ../python && python -m unittest discover -s tests
npm audit
```

Rotating the receipt key: generate a new `RECEIPT_SIGNING_KEY`, put the *old* public key (from `/.well-known/mandate-receipt-key` before the switch) into `RECEIPT_PREVIOUS_PUBLIC_KEYS`, deploy. Old anchors, receipts and vouchers keep verifying; new ones are signed with the new key; `/anchors` shows both key ids.
