# Security policy

Mandate stands between agents and money, so we treat security reports as the most important issues we get.

## Reporting a vulnerability

Please **do not** open a public issue. Email **mandateappnotify@gmail.com** with:

- what you found and where (URL, endpoint, or file),
- steps to reproduce, or a proof of concept,
- what an attacker could do with it,
- how you'd like to be credited, if at all.

You'll get an acknowledgement within 48 hours and a fix or a plan within 7 days for anything that lets an agent exceed its mandate, reach another workspace, or reveal a stored key. We'll tell you when it's fixed and credit you in the changelog unless you'd rather we didn't.

## Scope

In scope: this repository and the hosted beta at `mandate-ashen.vercel.app`. Of particular interest —

- any way to spend outside a mandate's terms, or to consume an approval twice,
- cross-workspace access through OAuth grants, tokens, proxy keys or receipts,
- forging or replaying one-tap approve/deny links,
- reading a stored provider key,
- tampering with the ledger without breaking verification,
- SSRF through webhook targets or client-metadata documents.

Out of scope: denial of service by volume, reports from automated scanners without a demonstrated impact, and issues in third-party services (Stripe, Vercel, Neon, Better Auth) — please report those upstream, but do let us know if Mandate's use of them is the problem.

## What has been reviewed

`docs/SECURITY-AUDIT.md` is the record of the 0.7.1 audit: what data Mandate holds and who can reach it, every finding with its fix and regression test, what was verified clean, and what is still open. Read it before reporting — several of the obvious probes (forged one-tap links, cross-mandate settlement, path escapes in the proxy, idempotency-key reuse, SSRF through webhooks) are already covered by tests you can run yourself.

## Key rotation

`RECEIPT_SIGNING_KEY` signs receipts, vouchers and public anchors. To rotate it, save the current public key (`/.well-known/mandate-receipt-key`), set the new seed, and list the old public key in `RECEIPT_PREVIOUS_PUBLIC_KEYS`. Everything signed before keeps verifying; anything signed under a key that is neither current nor listed is reported as a break, never tolerated. `MANDATE_ENCRYPTION_KEY` cannot be rotated in place yet: re-enter provider keys and target credentials after changing it.

## Supported versions

The `main` branch and the hosted beta. Older commits are not patched.

## Testing safely

Please test against your own local instance (`npm run dev`) or your own workspace on the beta. Don't touch other people's workspaces or try to exhaust the hosted service.
