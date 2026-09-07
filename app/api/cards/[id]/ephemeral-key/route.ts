import { NextRequest, NextResponse } from "next/server";
import { getCtx, can } from "@/lib/session";
import { getMandate } from "@/lib/service";
import { stripeEnabled, cardEphemeralKey } from "@/lib/stripe";
import { rateLimit } from "@/lib/ratelimit";
import { recordEvent } from "@/lib/ledger";

// Exchanges a Stripe.js nonce for an ephemeral key scoped to one card, so the
// browser can render the number, expiry and CVC through Issuing Elements.
// The PAN never touches our server or our logs. Owners and admins only, and
// every reveal is written to the ledger.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getCtx();
  if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!(await can({ mandate: ["issue"] }))) return NextResponse.json({ error: "Only owners and admins can view card details." }, { status: 403 });
  if (!stripeEnabled()) return NextResponse.json({ error: "Stripe is not configured." }, { status: 503 });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Bad id." }, { status: 400 });
  const rl = await rateLimit(`user:${session.userId}:card-reveal`, 20, 3600);
  if (!rl.ok) return NextResponse.json({ error: "Too many reveals this hour." }, { status: 429 });
  const m = await getMandate(session.workspaceId, id);
  if (!m?.stripeCardId) return NextResponse.json({ error: "This mandate has no card." }, { status: 404 });
  let nonce = "";
  try { nonce = String(((await req.json()) as { nonce?: unknown }).nonce ?? ""); } catch { /* fallthrough */ }
  if (!nonce || nonce.length > 200) return NextResponse.json({ error: "Missing nonce." }, { status: 400 });
  try {
    const key = await cardEphemeralKey(m.stripeCardId, nonce);
    await recordEvent(session.workspaceId, "mandate.card_revealed", { mandateId: m.id, by: session.email });
    return NextResponse.json({ secret: key.secret, cardId: m.stripeCardId });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
