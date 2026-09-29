# Changelog

All notable changes to Mandate. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

## [0.7.1] — 2026-09-28

A security audit of everything built so far — every rail, every connection, every stored secret — with each finding fixed and pinned by a test. The full record, including what is still open, is `docs/SECURITY-AUDIT.md`.

### Fixed (security)
- **Settlement authority.** An agent can no longer void or capture card holds (settled by Stripe), proxy holds (settled by the proxy), dispute rows, expired holds, or holds for which a voucher has been issued; the owner cannot settle card holds by hand. (`settleProblem()`)
- **Observe mode** no longer overrides the hard rules: freeze, pause, revocation, expiry, balance, malformed amounts and every `parent_*` rule are enforced in every mode.
- **Co-signing** counts approvers by account (`signoffs[].userId`), not by e-mail spelling; anonymous one-tap links are refused for multi-approver requests; one-tap tokens are bound to their recipient and re-check membership on use; the `/a/:id` and `/p/:id` pages reveal nothing without a valid token.
- **Vouchers** are no longer embedded in the authorisation answer (which was logged everywhere): the answer carries `voucherUrl`; fetching the voucher marks the hold (`transactions.voucher_issued_at`) so the agent cannot settle it underneath the merchant. Vouchers are refused for sandbox, card, proxy and dispute rows and must be redeemed at the named merchant.
- **Idempotency** keys record a hash of the request body; the same key with a different body is `422`, not a replay. REST refuses the `mcp:` key namespace.
- **SSRF.** All outbound requests to user-supplied addresses (event webhooks, notification webhooks, generic proxy targets) go through `safeFetch()`, which pins the DNS answer it checked (no rebinding), refuses private and cloud-metadata ranges, follows no redirects, and caps time and size. Push endpoints are allow-listed to the browser vendors (`PUSH_EXTRA_HOSTS`).
- **Generic proxy** refuses paths that escape the target's base, caps responses at 20 MB and 120 s.
- **LLM proxy** forwards the body it priced (re-serialised), keeps the *tail* of a stream so the usage frame is never lost, settles an aborted stream at `max(reported, estimate)`, and matches model prices only on exact names or dated versions (`gpt-5-pro` is no longer priced as `gpt-5`; new entries for `-pro`, `o1`, `o3-mini`, deep-research, `claude-opus-4-5`).
- **Stripe** incremental authorisations run through the policy engine; events deduplicate atomically; `stripe_authorization_id` is unique; over-captures raise a warning.
- **Disputes** refund at most what was captured, net of earlier refunds; card rows cannot be marked refunded; pausing needs `mandate:revoke`, refunding `mandate:issue`.
- **Receipts** name roles, not people: addresses are redacted to `a…@domain`, account ids dropped, the workspace shown by its public label, and only rows about that decision included. The stored passkey signature is re-verified *and* checked to commit to that approval and verdict.
- **Anchors** under a key that is neither current nor listed in `RECEIPT_PREVIOUS_PUBLIC_KEYS` are a verification failure, not a footnote; the public verifier is cached per instance; `?label=` filters in SQL; `/.well-known/mandate-receipt-key` advertises retired keys.
- **Bounds everywhere**: `MAX_AMOUNT` on routes, targets, raises, delegations and forms; hours capped; ≤ 50 routes per workspace; ≤ 10 children per mandate; delegation rate-limited; the public receipt verifier capped at 5 MB / 20 000 events / 30 req·min; voucher bodies at 16 KB.
- **Cross-site requests** to cookie-authenticated JSON routes (`push/subscribe`, `mandates/:id/replay`, `cards/:id/ephemeral-key`, `approvals/:id/sign`, `dev/seed`) are refused by `Origin` / `Sec-Fetch-Site`.
- Also: `LIKE` escaping in the activity feed (after truncation, ids validated); `safeNext()` for every `next=`; passkey challenges dated in the future refused; Better Auth's organisation-delete endpoint disabled (the account page's purge is the only path, and it settles holds and tombstones anchors); AES-GCM tag length pinned; timing-safe cron secret; `Referrer-Policy: no-referrer` + `no-store` on `/a`, `/p`, `/r`; the mailer throws in production without a transport instead of printing sign-in links to the log (`EMAIL_CONSOLE=1` for tests); plans name exact merchants (no wildcards).

### Changed
- `POST /api/agent/authorize` and MCP `authorize` return `voucherUrl` instead of `voucher`. SDKs 0.7.1: `AuthorizeResult.voucherUrl`; `voucher(transactionId)` unchanged.
- Forwarded-address headers are trusted on Vercel or when `TRUST_PROXY=true`; elsewhere all clients share one rate-limit bucket. Self-hosters behind their own reverse proxy should set `TRUST_PROXY=true`.
- `GET /api/account/export` includes every table that mentions you or your workspaces, with secret columns stripped.
- `GET /api/ledger/anchors` includes `previousKeys`; transaction receipts' `chain.workspaceId` is now `chain.label`.

### Added
- `docs/SECURITY-AUDIT.md`; `RECEIPT_PREVIOUS_PUBLIC_KEYS`, `EMAIL_CONSOLE`, `PUSH_EXTRA_HOSTS`, `PROXY_TARGET_ALLOW_PRIVATE`; `lib/net.ts`, `lib/safe-fetch.ts`, `lib/safe-next.ts`, `lib/cron-auth.ts`, `lib/ws-label.ts`; eight "hardening" integration tests and twelve new end-to-end checks.

### Migration
`npm install` (adds `undici`), then `npm run db:migrate` (adds `0011`: `idempotency_keys.request_hash`, `mandates.delegated_by`, `transactions.voucher_issued_at`, unique `txn_stripe_auth_idx`). Agents reading `voucher` from the authorisation answer must fetch `voucherUrl` instead.

## [0.7.0] — 2026-09-25

Authority that travels, authority that is shared, and a history nobody can quietly rewrite: vouchers a merchant verifies without an account, sub-mandates an agent delegates, co-signed approvals, routed inboxes, disputes, a panic button, public anchoring, sandboxes, and a proxy for any API.

### Added
- **Panic button** ("Freeze all" in the top bar, two clicks): `workspace_settings.frozen_*`; the engine's first rule is now `frozen`, so every rail declines with `approvalRequired` until unfrozen. Nothing is revoked. Ledger events `workspace.frozen` / `workspace.unfrozen`.
- **Authorisation vouchers**: an approved hold's answer carries `voucher` (`mv1.<payload>.<Ed25519 sig>`), also at `GET /api/agent/transactions/:id/voucher`, MCP `get_voucher`, SDK `voucher()`. Merchants verify offline with `/.well-known/mandate-receipt-key` (or `POST /api/vouchers/verify`) and redeem at `POST /api/vouchers/redeem` for at most the authorised amount, once; the capture is recorded as `merchant:<name>`.
- **Co-signing**: `cosign_above` / `cosign_count` (2–5) on a mandate; asks above the threshold need that many distinct approvers (`approvals.required_approvers`, `signoffs`); one denial ends the request; passkey-signed co-signatures are recorded; the inbox shows progress and hides the button once you have signed. Event `approval.cosigned`.
- **Approval routing** (`/settings/routing`): routes by amount band, category, merchant pattern and mandate to chosen deciders, in priority order; the matching route is stored on the request (`approvals.route_id`), notifications and push go to its members, and the inbox marks the request as theirs. Everyone who may decide still may.
- **Sub-mandates**: `POST /api/agent/delegate`, MCP `delegate`, SDK `delegate()`. Terms must fit inside the parent (`validateChildTerms`); the parent's veto, co-sign, hold and hours carry over where they still make sense; `mandates.parent_id` / `depth` (max 3); a family's spend counts against every ancestor (`parent_<rule>` declines); revocation cascades; the exposure page draws the tree.
- **Disputes**: open one from a decision row (optionally pausing the mandate); resolve from the inbox or the mandate page as refunded (a negative approved row nets the limits down), upheld or withdrawn. Table `disputes`, `transactions.dispute_id`, events `dispute.*`.
- **Ledger anchoring**: `ledger_anchors` — a public, deployment-wide chain of signed ledger heads (`/anchors`, `GET /api/ledger/anchors`), written by the daily cron and by the health ping when a day has passed; a workspace appears as `sha256("mandate-ws:" + id)`. The ledger page shows the latest anchor; transaction receipts carry the anchor covering their decision rows; anchor verification tolerates key rotation.
- **Sandbox mandates**: `mandates.sandbox`, `mnd_test_` tokens, no cards or proxy keys, excluded from stats and headline totals, "Reset sandbox" wipes decisions (event `mandate.sandbox_reset`).
- **Generic API proxy**: `proxy_targets` (any https API, credential injected in a chosen header, priced per call or from a response header / JSON path); `/api/proxy/t/<slug>/…` for any method; proxy keys can bind to a target (`proxy_keys.target_id`); settlement caps at the pre-authorised amount and warns on overrun. `PROXY_TARGET_ALLOW_PRIVATE=1` permits private base URLs for self-hosted internal APIs.
- Activity feed group **Disputes**; sentences for every new event; MCP server and stdio server 0.7.0; SDKs 0.7.0 (`voucher`, `delegate`, `sandbox`).

### Changed
- `proxy_keys.provider_key_id` is now nullable (a key is bound to a provider key or a target).
- `GET /api/agent/mandate` reports `sandbox`, `frozen`, `parentId`, `subMandates` and co-sign terms.
- The engine's rule order is now: frozen, paused, status, expiry, hours, merchant, category, per-transaction, daily, total, balance, **ancestors**, plan, escalation, veto.

### Migration
`npm run db:migrate` (adds `0010`). Optional: `PROXY_TARGET_ALLOW_PRIVATE=1`. The daily cron (`/api/cron/cleanup`) now also anchors ledgers.

## [0.6.0] — 2026-09-25

The ideas nobody else has shipped: approval by silence, plans approved once, terms you can rehearse, history you can replay, limits that are earned, and approvals a human provably signed.

### Added
- **Veto windows**: a second threshold below "ask me above". Requests above it are announced and go through after the window (default 15 min) unless the owner cancels — from the inbox, the email, or a push notification. Agents get `pending` with rule `veto` and a `retryAt`.
- **Pre-approved plans**: `POST /api/agent/plans` and the MCP tools `propose_plan` / `get_plan` (also in both SDKs and the stdio server). The owner approves the list once from the inbox (or a one-tap link at `/p/:id`); each item then passes with rule `plan`, once, within the limits. Items above the per-transaction limit are refused up front.
- **Shadow mode**: a mandate in `observe` lets everything through and records what the terms would have decided; the mandate page shows the report and a one-click switch to enforce. Selectable at issue time and on the mandate page.
- **Policy time-travel**: the What-if panel on the mandate page (and `POST /api/mandates/:id/replay`) replays the real history through the real engine under different terms and lists the decisions that would have changed.
- **Graduated autonomy**: optional per mandate — every N clean decisions the per-transaction limit and the ask-me-above threshold rise by a step toward a ceiling; a denial or a decline burst steps back; a trust track on the mandate page; owners can reset to probation.
- **Human-signed approvals**: "Approve once · signed" in the inbox signs the exact decision with the approver's passkey (WebAuthn); the signature is stored with the approval, digested into the ledger event, carried on the public receipt and re-verified by the receipt verifier.

### Changed
- `mandates` gained `veto_above`, `veto_minutes`, `mode`, `autonomy_*`; `approvals` gained `kind`, `veto_until`, `signed_with`, `signature`; `transactions` gained `shadow_*`, `plan_id`; new table `plans` (migration `0009`).
- `@simplewebauthn/server` is now a direct dependency (it was already pulled in by Better Auth's passkey plugin).

### Migration
`npm run db:migrate` (adds `0009`). No new environment variables.

## [0.5.0] — 2026-09-25

Launch set: the things that make the demo good, give developers something to install, and give owners a reason to keep it on their phone.

### Added
- **Connect wizard** (`/connect`): one page per rail — Claude Desktop, Claude Code, Cursor/any MCP client, Python, TypeScript, curl, LLM-SDK proxy — with the mandate token filled into the snippets while the show-once window is open, and a live check that lights up when the first call lands.
- **SDKs**: `sdk/python` (`pip install mandate-agent`) and `sdk/typescript` (`npm install mandate-agent`), zero dependencies, with `authorize`/`capture`/`void`, a hold helper that voids on error, polling for pending approvals, and tools for the OpenAI Agents SDK, LangChain, the OpenAI SDK and the Vercel AI SDK.
- **Push approvals + PWA**: installable manifest and service worker; approval requests as notifications with Approve / Deny buttons that decide through the signed one-tap endpoint (`POST /api/approvals/onetap/:id`). Per-device subscriptions in Settings. Needs VAPID keys.
- **Public receipts**: share any decision as `/r/:id?k=…` — a signed page with the request, the answer, the terms, the human approval and the ledger rows, verifiable in the reader's browser with WebCrypto; JSON at `/api/receipts/tx/:id`. Un-share at any time.
- **Templates and duplicate**: six presets scaled to the workspace currency on the issue page; "Duplicate" on any mandate.
- **Pause / resume** (timed or until further notice) and **temporary raises** of one limit for a window, both without editing the issued terms; agents get `paused` with a resume time.
- **Anomaly flags** on decisions and requests: unusual amount, new merchant, decline burst, rapid repeat — shown in the inbox, mandate page, feed, email, push and webhooks.

### Changed
- `mandates` gained `paused_until`, `paused_by`; `transactions` gained `flags`, `share_token`; `approvals` gained `flags`; new tables `mandate_overrides`, `push_subscriptions` (migration `0008`).
- Canonical JSON now drops keys whose value is undefined (no existing hashes change).
- The topbar's "Connect agents" now opens the wizard; `/docs` remains the reference.

### Migration
`npm run db:migrate` (adds `0008`). Optional new env: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` for push.

## [0.4.0] — 2026-09-25

The money layer grows up: approvals become holds, agents are told what to do about a "no", every event can be pushed to your own systems, and the ledger reads as sentences.

### Added
- **Holds, capture and void.** An approval is a hold until the agent reports what it paid: `POST /api/agent/capture` (less than authorised releases the difference), `POST /api/agent/void`, `GET /api/agent/transactions/:id`, and the MCP tools `capture_purchase`, `void_purchase`, `get_purchase` (also in the stdio server). Per-mandate hold TTL (default 24 h) and expiry policy (capture in full, or release). Owners can settle a hold from the mandate page. Open holds shown on the exposure page and in `GET /api/agent/mandate`.
- **Remedies on every non-approval.** Declines and pendings carry `remedy` — when the same request would pass (`retryAt`, also as `x-mandate-retry-at`), the largest amount that would pass now (`maxAmountNow`), the allowed merchants, whether a human must act — on REST, MCP and the proxy.
- **Event webhooks** (Settings → Event webhooks): every ledger event as signed JSON to up to ten endpoints per workspace, with event filters, per-endpoint ordering, retries with backoff, auto-pause after repeated failures, test events, secret rotation and a delivery log. `GET /api/cron/dispatch` for schedulers that can run more often than daily; the health ping also drains due retries.
- **Activity feed** (`/activity`): the ledger as sentences, filterable by kind, outcome, agent, mandate, date and text, with notes on any decision, approval or event.
- **Currencies.** 38 currencies with correct minor units (¥ has none, KWD has three) and locale-aware formatting; a workspace default currency in Settings.

### Changed
- `transactions` gained `authorized_amount`, `settlement`, `hold_expires_at`, `settled_at`, `settled_by`, `settlement_note`; `mandates` gained `hold_ttl_hours`, `hold_policy`; new tables `webhook_endpoints`, `webhook_deliveries`, `notes`, `workspace_settings` (migration `0007`, which also marks every existing approved decision as captured).
- Proxy settlements and Stripe reconciliation now record their outcome in `settlement` rather than overwriting the decision's reason.
- Stripe-side voids keep `decision = approved` and set `settlement = voided` (was `decision = voided`).
- Seed data includes a captured and an open hold; the demo mandate's daily limit is $150.

### Migration
`npm run db:migrate` (adds `0007_phase1_holds_webhooks_activity`). No environment changes required; `WEBHOOK_ALLOW_PRIVATE=1` is new and optional.

## [0.3.0] — 2026-09-24

First public beta.

### Added
- MCP server with OAuth 2.1 (PKCE, CIMD, dynamic registration); grants bound to the consented workspace with live role checks.
- API-key proxy for OpenAI, Anthropic and Gemini: encrypted provider keys, mandate-bound proxy keys, per-call estimate and settlement, streaming.
- REST authorisation endpoint with idempotency keys.
- Approvals with one-tap signed links by email or webhook; 24 h allowances; 6 h denial cooling-off.
- Hash-chained ledger, Ed25519-signed receipts, public verifier and key.
- Stripe Issuing virtual cards on a prepaid balance (operator opt-in; US/UK/EEA).
- Stats page: day/week/month/year, by agent or merchant, heat map, written analysis.
- Workspaces with owner/admin/approver/viewer roles and email invitations.
- Google, magic-link and passkey sign-in; light/dark themes.
- Health endpoint, daily cleanup cron, deployment preflight script.
- Deployment paths: Vercel + Neon (primary), AWS EC2, AWS ECS Fargate, Docker.

### Changed
- Licence: AGPL-3.0 (was MIT during private development). Sole-author relicense before any external contribution.

### Fixed
- Claude's client-metadata document could not be fetched on Node 20+ (Better Auth CIMD ≤ 1.7.2); upgraded to 1.7.5 with migration `0006`.
- OAuth authorization-server metadata is also served at the bare `/.well-known/oauth-authorization-server` for clients that skip protected-resource discovery.

[Unreleased]: https://github.com/Ivan825/Mandate/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/Ivan825/Mandate/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Ivan825/Mandate/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Ivan825/Mandate/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Ivan825/Mandate/releases/tag/v0.3.0
