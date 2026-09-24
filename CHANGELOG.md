# Changelog

All notable changes to Mandate. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/Ivan825/Mandate/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Ivan825/Mandate/releases/tag/v0.3.0
