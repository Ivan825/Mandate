import { NextRequest, NextResponse, after } from "next/server";
import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { stripe, stripeEnabled, STRIPE_RESPONSE_VERSION } from "@/lib/stripe";
import { getMandateByCard, authorize, reconcileCard, voidTransactionByStripeAuthorization } from "@/lib/service";
import { recordEvent } from "@/lib/ledger";
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
  await db.insert(schema.stripeEvents).values({ id: event.id, type: event.type, receivedAt: new Date() }).onConflictDoNothing();
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
      if (!m) return decision(false, { reason: "unknown_card" });
      // Stripe may re-send a request (retry, or an incremental authorisation
      // on the same id). Answer as before rather than decide twice.
      const [prior] = await db.select({ decision: schema.transactions.decision }).from(schema.transactions).where(eq(schema.transactions.stripeAuthorizationId, auth.id)).limit(1);
      if (prior) return decision(prior.decision === "approved", { mandateId: m.id, replayed: "true" });
      const r = await authorize(m, {
        amount: auth.pending_request?.amount ?? auth.amount,
        merchant: auth.merchant_data?.name ?? "unknown merchant",
        category: auth.merchant_data?.category ?? "",
        purpose: "card authorisation",
      }, "stripe", {
        stripeAuthorizationId: auth.id, actor: `card ···${m.cardLast4 ?? ""}`,
        // Answer Stripe first; notify approvers and check warnings after the
        // response is sent, so a slow email or webhook never times out a card.
        background: (work) => after(work),
      });
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
    if (event.type === "issuing_authorization.updated") {
      const a = event.data.object as Stripe.Issuing.Authorization;
      if (a.status === "reversed") await reconcileCard(a.id, "reversal", 0, event.id);
      else if (a.status === "closed") await reconcileCard(a.id, "closed", 0, event.id);
    } else if (event.type === "issuing_transaction.created") {
      const t = event.data.object as Stripe.Issuing.Transaction;
      const authId = typeof t.authorization === "string" ? t.authorization : t.authorization?.id;
      const at = new Date(t.created * 1000);
      if (authId && t.type === "capture") await reconcileCard(authId, "capture", Math.abs(t.amount), event.id, at);
      else if (authId && t.type === "refund") await reconcileCard(authId, "refund", Math.abs(t.amount), event.id, at);
    } else if (event.type === "issuing_authorization.created") {
      const obj = event.data.object as Stripe.Issuing.Authorization;
      const cardId = typeof obj.card === "string" ? obj.card : obj.card?.id;
      const m = cardId ? await getMandateByCard(cardId) : null;
      if (m) {
        await recordEvent(m.workspaceId, "stripe.authorization.created", { id: obj.id, mandateId: m.id, amount: obj.amount, approved: obj.approved, lastReason: obj.request_history?.at(-1)?.reason ?? null });
        // We said yes but Stripe declined anyway (its own controls, a timeout
        // on our answer, insufficient balance): release the spend.
        if (obj.approved === false) await voidTransactionByStripeAuthorization(obj.id, obj.request_history?.at(-1)?.reason ?? "stripe_declined");
      }
    }
  } catch (e) {
    console.error("webhook record failed:", (e as Error).message);
  }
  return NextResponse.json({ received: true });
}
