import Stripe from "stripe";
import type { Mandate } from "./schema";

export function stripeEnabled(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

let client: Stripe | null = null;
export function stripe(): Stripe {
  if (!client) client = new Stripe(process.env.STRIPE_SECRET_KEY!);
  return client;
}

// The API version we answer real-time authorisations with. Stripe requires
// this header on the webhook response; a missing or unsupported value is
// treated as a webhook error and falls back to your account's timeout rule.
export const STRIPE_RESPONSE_VERSION = process.env.STRIPE_API_VERSION ?? "2025-02-24.acacia";

function cardholderName(agentName: string): string {
  // Stripe accepts letters, spaces and a few punctuation marks; keep it plain.
  const clean = agentName.replace(/[^A-Za-z ]+/g, " ").replace(/\s+/g, " ").trim();
  return ("Agent " + (clean || "Mandate")).slice(0, 24).trim();
}

// Issue a virtual card for a mandate. Stripe's own spending_controls are set
// as a second line of defence; the real-time authorisation webhook is where
// the full mandate (merchant scope, hours, escalation) is enforced.
export async function issueCardForMandate(m: Mandate, holder: { name: string; email: string; address?: Stripe.Issuing.CardholderCreateParams.Billing.Address }) {
  const s = stripe();
  const cardholder = await s.issuing.cardholders.create({
    name: cardholderName(holder.name),
    email: holder.email,
    type: "individual",
    status: "active",
    billing: { address: holder.address ?? { line1: "1 Agent Way", city: "San Francisco", state: "CA", postal_code: "94110", country: "US" } },
    metadata: { mandateId: m.id, agentId: m.agentId },
  });
  const card = await s.issuing.cards.create({
    cardholder: cardholder.id,
    currency: m.currency.toLowerCase(),
    type: "virtual",
    status: "active",
    spending_controls: {
      spending_limits: [
        { amount: m.perTxnLimit, interval: "per_authorization" },
        { amount: m.dailyLimit, interval: "daily" },
        { amount: m.totalLimit, interval: "all_time" },
      ],
    },
    // Never put the mandate token here: metadata is visible in the Stripe
    // dashboard and in every webhook payload.
    metadata: { mandateId: m.id, agentId: m.agentId },
  });
  return { cardholderId: cardholder.id, cardId: card.id, last4: card.last4 };
}

export async function deactivateCard(cardId: string) {
  await stripe().issuing.cards.update(cardId, { status: "canceled" });
}

// Test-mode helper: make Stripe fire a real issuing_authorization.request at
// our webhook, so the whole loop can be exercised without a physical swipe.
export async function simulateStripeAuthorization(cardId: string, amount: number, merchantName: string) {
  return stripe().testHelpers.issuing.authorizations.create({
    card: cardId,
    amount,
    merchant_data: { name: merchantName, category: "computer_software_stores" },
  });
}
