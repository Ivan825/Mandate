# Contributing to Mandate

Thanks for looking. Mandate is small enough that one person can hold the whole thing in their head, and we'd like to keep it that way — so the bar for a change is "does this make an agent safer to trust with money, or the person's job easier", not "is this a feature".

## Before you start

- **Bugs**: open an issue with the steps, what you expected, what happened, and the request id from the ledger row or the `x-request-id` header if you have it. Screenshots welcome.
- **Features**: open an issue first so we can talk about whether it fits before you spend an evening on it.
- **Security**: don't open an issue. See [`SECURITY.md`](SECURITY.md).

## Setting up

```bash
git clone https://github.com/Ivan825/Mandate.git && cd Mandate
cp .env.example .env
docker compose up -d db          # or point DATABASE_URL at your own Postgres 16
npm install
npm run db:migrate
npm run dev
```

Sign in with any address; the link prints to the terminal. `fetch('/api/dev/seed', {method:'POST'})` from the browser console fills the workspace with demo data.

## Making a change

1. Branch from `main`.
2. Keep the policy engine (`lib/policy.ts`) pure — no I/O — and put the database work in `lib/service.ts`.
3. Anything that touches a decision path must keep idempotency semantics: reserve before deciding, replay terminal answers, never replay *pending*.
4. Schema changes go through Drizzle: edit `lib/schema.ts`, run `npx drizzle-kit generate --name <what-changed>`, commit the SQL and the snapshot together. Migrations are forward-only; don't edit one that's been merged.
5. Add or extend a test at the lowest level that can catch the regression: unit for rules, integration for anything that needs the database, end-to-end only for flows that cross the browser.
6. Run the lot before opening the PR:
   ```bash
   npx tsc --noEmit && npm test && npm run test:integration && npm run build && npm run test:e2e
   ```

## Style

TypeScript, no default exports for library code, no comments that restate the code. Explain *why* when it isn't obvious — especially around money, time zones and concurrency. Currency amounts are integers in minor units everywhere; times are stored in UTC and rendered in the mandate's or the viewer's zone. Copy in the UI is plain, specific and in the second person.

## Pull requests

One change per PR. The description should say what it fixes or adds, how you tested it, and whether it changes a migration, an environment variable or a public API (`/api/agent`, `/api/mcp`, `/api/proxy`, receipts). CI must be green. A maintainer will review within a few days.

## Licence

By contributing you agree your work is released under the [MIT licence](LICENSE).
