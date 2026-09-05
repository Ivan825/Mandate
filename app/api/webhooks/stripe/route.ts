import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { stripe, stripeEnabled } from "@/lib/stripe";
import { getMandateByCard, authorize } from "@/lib/service";
import { appendEvent } from "@/lib/ledger";

// Stripe Issuing real-time authorisation. When the agent's virtual card is
// used, Stripe sends issuing_authorization.request and waits (2 seconds) for
// our answer. We evaluate the full mandate and answer in the response body.
// Everything else (captures, declines Stripe made itself) is recorded.

export async function POST(req: NextRequest) {
  if (!stripeEnabled()) return NextResponse.json({ error: "Stripe not configured." }, { status: 503 });
  const sig = req.headers.get("stripe-signature") ?? "";
  const raw = await req.text();
  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(raw, sig, process.env.STRIPE_WEBHOOK_SECRET ?? "");
  } catch (e) {
    return NextResponse.json({ error: `Webhook signature failed: ${(e as Error).message}` }, { status: 400 });
  }

  if (event.type === "issuing_authorization.request") {
    const auth = event.data.object as Stripe.Issuing.Authorization;
    const cardId = typeof auth.card === "string" ? auth.card : auth.card.id;
    const m = await getMandateByCard(cardId);
    if (!m) {
      await appendEvent("stripe.unknown_card", { cardId, authorizationId: auth.id });
      return NextResponse.json({ approved: false }, { status: 200 });
    }
    const r = await authorize(
      m,
      {
        amount: auth.pending_request?.amount ?? auth.amount,
        merchant: auth.merchant_data?.name ?? "unknown merchant",
        category: auth.merchant_data?.category ?? "",
        purpose: "card authorisation",
      },
      "stripe",
      { stripeAuthorizationId: auth.id }
    );
    // "pending" cannot hold a card network open: decline now, and the
    // approval sits in the inbox so the agent can retry once it's granted.
    return NextResponse.json({ approved: r.decision === "approved", metadata: { mandateId: m.id, rule: r.rule } }, { status: 200 });
  }

  if (event.type === "issuing_authorization.created" || event.type === "issuing_transaction.created") {
    const obj = event.data.object as { id: string; amount?: number; approved?: boolean };
    await appendEvent(`stripe.${event.type}`, { id: obj.id, amount: obj.amount ?? null, approved: obj.approved ?? null });
  }
  return NextResponse.json({ received: true });
}
