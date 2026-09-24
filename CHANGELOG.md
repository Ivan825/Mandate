# Changelog

All notable changes to Mandate. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/Ivan825/Mandate/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/Ivan825/Mandate/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Ivan825/Mandate/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Ivan825/Mandate/releases/tag/v0.3.0
