import Stripe from "stripe";
import type { Mandate } from "./schema";
import { appUrl } from "./env";

export function stripeEnabled(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}
export function stripePublishableKey(): string | null {
  return process.env.STRIPE_PUBLISHABLE_KEY ?? null;
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

// Where the operator's Stripe account lives decides the card currency and
// which cardholder countries are allowed: a US account issues USD cards to
// US addresses, a UK account GBP to UK, an EU account EUR to EEA.
const REGIONS: Record<string, { currency: string; countries: string[] }> = {
  US: { currency: "USD", countries: ["US"] },
  GB: { currency: "GBP", countries: ["GB"] },
  EU: { currency: "EUR", countries: ["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "NO", "IS", "LI"] },
};
export function issuingRegion(): { code: string; currency: string; countries: string[] } {
  const code = (process.env.STRIPE_ISSUING_REGION ?? "US").toUpperCase();
  const r = REGIONS[code] ?? REGIONS.US;
  return { code: REGIONS[code] ? code : "US", ...r, currency: (process.env.STRIPE_ISSUING_CURRENCY ?? r.currency).toUpperCase() };
}
// UK and EU cardholders must accept Stripe's cardholder terms explicitly.
export function termsAcceptanceRequired(): boolean {
  return issuingRegion().code !== "US";
}

function cardholderName(name: string): string {
  // Stripe accepts letters, spaces and a few punctuation marks; keep it plain.
  const clean = name.replace(/[^A-Za-z ]+/g, " ").replace(/\s+/g, " ").trim();
  return (clean || "Mandate Holder").slice(0, 24).trim();
}

export type CardholderProfile = {
  name: string; email: string; phone?: string; dob?: string; line1: string; line2?: string; city: string; state?: string; postalCode: string; country: string;
  termsAcceptedAt?: Date | null; termsIp?: string; termsUserAgent?: string; stripeCardholderId?: string | null;
};

// Why a card cannot be issued yet, in the person's words; null when ready.
export function cardholderProblem(p: CardholderProfile | null): string | null {
  if (!p) return "Add your cardholder details (name, date of birth, phone and billing address) in Settings.";
  const region = issuingRegion();
  if (!region.countries.includes(p.country.toUpperCase())) return `This deployment issues ${region.currency} cards to addresses in ${region.code === "EU" ? "the EEA" : region.code} only; the saved billing address is in ${p.country}.`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.dob ?? "")) return "Stripe needs the cardholder's date of birth (YYYY-MM-DD) in Settings.";
  if (!p.phone) return "Stripe needs a mobile number for the cardholder (used for 3-D Secure checks) in Settings.";
  if (termsAcceptanceRequired() && !p.termsAcceptedAt) return "Accept Stripe's cardholder terms in Settings before a card can be issued.";
  return null;
}

// One Stripe cardholder per workspace, created on first use and reused.
export async function ensureCardholder(holder: CardholderProfile, workspaceId: string): Promise<string> {
  if (holder.stripeCardholderId) return holder.stripeCardholderId;
  const s = stripe();
  const [y, mo, d] = (holder.dob ?? "").split("-").map((n) => parseInt(n, 10));
  const parts = holder.name.trim().split(/\s+/);
  const cardholder = await s.issuing.cardholders.create({
    name: cardholderName(holder.name),
    email: holder.email,
    phone_number: holder.phone || undefined,
    type: "individual",
    status: "active",
    individual: {
      first_name: parts[0],
      last_name: parts.slice(1).join(" ") || parts[0],
      dob: y && mo && d ? { year: y, month: mo, day: d } : undefined,
      card_issuing: holder.termsAcceptedAt ? { user_terms_acceptance: { date: Math.floor(holder.termsAcceptedAt.getTime() / 1000), ip: holder.termsIp || undefined, user_agent: holder.termsUserAgent || undefined } } : undefined,
    },
    billing: { address: { line1: holder.line1, line2: holder.line2 || undefined, city: holder.city, state: holder.state || undefined, postal_code: holder.postalCode, country: holder.country } },
    metadata: { workspaceId },
  });
  return cardholder.id;
}

// Issue a virtual card for a mandate. Stripe's own spending_controls are set
// as a second line of defence; the real-time authorisation webhook is where
// the full mandate (merchant scope, hours, escalation, prepaid balance) is
// enforced.
export async function issueCardForMandate(m: Mandate, cardholderId: string) {
  const s = stripe();
  const card = await s.issuing.cards.create({
    cardholder: cardholderId,
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
    metadata: { mandateId: m.id, agentId: m.agentId, workspaceId: m.workspaceId },
  });
  return { cardholderId, cardId: card.id, last4: card.last4, expMonth: card.exp_month, expYear: card.exp_year };
}

export async function deactivateCard(cardId: string) {
  await stripe().issuing.cards.update(cardId, { status: "canceled" });
}
export async function freezeCard(cardId: string, frozen: boolean) {
  await stripe().issuing.cards.update(cardId, { status: frozen ? "inactive" : "active" });
}

// Card number, CVC and expiry are shown in the browser through Stripe's
// Issuing Elements, never through our server: the client asks Stripe.js for
// a nonce, we exchange it for a short-lived ephemeral key scoped to one card.
export async function cardEphemeralKey(cardId: string, nonce: string): Promise<{ secret: string }> {
  const key = await stripe().ephemeralKeys.create({ issuing_card: cardId, nonce }, { apiVersion: STRIPE_RESPONSE_VERSION });
  return { secret: key.secret! };
}

// Money in: a Checkout session for a prepaid top-up. The webhook (and the
// success page, whichever is first) credits the workspace by session id.
export async function createTopupSession(input: { workspaceId: string; currency: string; amount: number; email: string; by: string }): Promise<string> {
  const base = appUrl();
  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    customer_email: input.email,
    client_reference_id: input.workspaceId,
    line_items: [{ quantity: 1, price_data: { currency: input.currency.toLowerCase(), unit_amount: input.amount, product_data: { name: "Mandate prepaid balance", description: "Funds your agents' virtual cards. Unspent balance is refundable on request." } } }],
    metadata: { workspaceId: input.workspaceId, currency: input.currency.toUpperCase(), amount: String(input.amount), by: input.by },
    success_url: `${base}/balance?session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/balance?topup=cancelled`,
  });
  if (!session.url) throw new Error("Stripe did not return a Checkout URL.");
  return session.url;
}

export async function retrieveTopupSession(sessionId: string) {
  const s = await stripe().checkout.sessions.retrieve(sessionId);
  return { id: s.id, paid: s.payment_status === "paid", workspaceId: s.metadata?.workspaceId ?? s.client_reference_id ?? null, currency: (s.currency ?? "").toUpperCase(), amount: s.amount_total ?? 0, by: s.metadata?.by ?? "" };
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
