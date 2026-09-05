import Stripe from "stripe";
import type { Mandate } from "./schema";

export function stripeEnabled(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

let client: Stripe | null = null;
export function stripe(): Stripe {
  if (!client) client = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2024-12-18.acacia" as Stripe.LatestApiVersion });
  return client;
}

// Issue a virtual card for a mandate. Stripe's own spending_controls are set
// as a second line of defence; the real-time authorisation webhook is where
// the full mandate (merchant scope, hours, escalation) is enforced.
export async function issueCardForMandate(m: Mandate, holder: { name: string; email: string }) {
  const s = stripe();
  const cardholder = await s.issuing.cardholders.create({
    name: holder.name,
    email: holder.email,
    type: "individual",
    status: "active",
    billing: { address: { line1: "1 Agent Way", city: "San Francisco", state: "CA", postal_code: "94110", country: "US" } },
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
    metadata: { mandateId: m.id, agentId: m.agentId, token: m.token },
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
