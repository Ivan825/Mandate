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

## Supported versions

The `main` branch and the hosted beta. Older commits are not patched.

## Testing safely

Please test against your own local instance (`npm run dev`) or your own workspace on the beta. Don't touch other people's workspaces or try to exhaust the hosted service.
