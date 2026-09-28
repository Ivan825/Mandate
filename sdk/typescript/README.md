# mandate-agent (TypeScript / Node)

Give your AI agent a spending mandate, not a card. This client talks to a [Mandate](https://github.com/Ivan825/Mandate) server with a mandate token: ask before paying, capture what was actually paid, void what wasn't. Uses the global `fetch`; no dependencies (Node 18+, Bun, Deno, edge runtimes).

```bash
npm install mandate-agent
```

```ts
import { Mandate } from "mandate-agent";

const m = new Mandate("mnd_…", { baseUrl: "https://mandate-ashen.vercel.app" });

// The safe pattern: a hold that settles itself.
const { state } = await m.withHold({ amount: 1299, merchant: "OpenAI", purpose: "API credits", idempotencyKey: "order-1" }, async () => {
  await payTheMerchant();
  return { paid: 1199 };      // less than authorised → the difference returns to the limits; throw or return null → voided
});

// Or step by step:
const a = await m.authorize({ amount: 1299, merchant: "OpenAI", idempotencyKey: "order-1", waitForMs: 60_000 });
if (a.decision === "approved") await m.capture(a.transactionId, { amount: 1199 });
else console.log(a.decision, a.reason, a.remedy);   // retryAt, maxAmountNow, allowedMerchants
```

- `authorize(input)` — `waitForMs` polls a *pending* answer (same idempotency key) until the owner decides.
- `mustAuthorize(input)` throws `MandateDeclined` (with `.remedy`) or `MandatePending`.
- `capture(id, { amount?, note? })`, `void(id, reason?)`, `get(id)`, `mandate()`.
- `proposePlan({ title, items, waitForMs? })`, `getPlan(id)` — get a whole shopping list approved once.
- `voucher(id)` — the signed authorisation voucher for an approved hold (`a.voucher` is already on the answer): hand it to the merchant, who verifies it offline and redeems it for what was actually sold.
- `delegate({ name, perTxnLimit, dailyLimit, totalLimit, … })` — carve a narrower sub-mandate out of yours for a helper; returns `{ token, client }`. Its spend counts against your limits; revoking yours revokes it.
- `sandbox` — true for a `mnd_test_` token (decisions are real, money never is).

Amounts are integers in the mandate's minor unit (cents, paise). A decline with rule `frozen` means the owner pressed the panic button — stop and tell the user.

## Agent frameworks

```ts
import { mandateTools } from "mandate-agent/ai";        // Vercel AI SDK: generateText({ tools: mandateTools(m) })
import { openaiTools, dispatch } from "mandate-agent/openai";   // OpenAI SDK function calling
```

Four tools: `check_mandate`, `request_purchase`, `capture_purchase`, `void_purchase`.

## Publishing (maintainers)

```bash
cd sdk/typescript && npm install && npm publish --access public
```

Licence: AGPL-3.0-only, like the server.
