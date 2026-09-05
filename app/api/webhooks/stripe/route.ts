import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { stripe, stripeEnabled, STRIPE_RESPONSE_VERSION } from "@/lib/stripe";
import { getMandateByCard, authorize } from "@/lib/service";
import { appendEvent } from "@/lib/ledger";
import { db, schema } from "@/lib/db";

export const maxDuration = 10;

// Stripe Issuing real-time authorisation. When the agent's virtual card is
// used, Stripe sends issuing_authorization.request and waits 2 seconds for
// our answer in the response body, which must carry a Stripe-Version header.
// Anything that goes wrong answers "declined" — the mandate fails closed.

function decision(approved: boolean, metadata: Record<string, string> = {}) {
  return NextResponse.json({ approved, metadata }, { status: 200, headers: { "Stripe-Version": STRIPE_RESPONSE_VERSION, "Content-Type": "application/json" } });
}

async function seenBefore(event: Stripe.Event): Promise<boolean> {
  const [row] = await db.select({ id: schema.stripeEvents.id }).from(schema.stripeEvents).where(eq(schema.stripeEvents.id, event.id)).limit(1);
  if (row) return true;
  await db.insert(schema.stripeEvents).values({ id: event.id, type: event.type, receivedAt: new Date() });
  return false;
}

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
    try {
      const auth = event.data.object as Stripe.Issuing.Authorization;
      const cardId = typeof auth.card === "string" ? auth.card : auth.card.id;
      const m = await getMandateByCard(cardId);
      if (!m) {
        await appendEvent("stripe.unknown_card", { cardId, authorizationId: auth.id });
        return decision(false, { reason: "unknown_card" });
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
      // "pending" cannot hold a card network open: decline now; the approval
      // sits in the inbox and the agent retries once it's granted.
      return decision(r.decision === "approved", { mandateId: m.id, rule: r.rule });
    } catch (e) {
      console.error("authorization.request failed closed:", (e as Error).message);
      return decision(false, { reason: "internal_error" });
    }
  }

  try {
    if (await seenBefore(event)) return NextResponse.json({ received: true, duplicate: true });
    if (event.type === "issuing_authorization.created" || event.type === "issuing_authorization.updated" || event.type === "issuing_transaction.created") {
      const obj = event.data.object as { id: string; amount?: number; approved?: boolean; request_history?: { reason?: string }[] };
      await appendEvent(`stripe.${event.type}`, { id: obj.id, amount: obj.amount ?? null, approved: obj.approved ?? null, lastReason: obj.request_history?.at(-1)?.reason ?? null });
    }
  } catch (e) {
    console.error("webhook record failed:", (e as Error).message);
  }
  return NextResponse.json({ received: true });
}
