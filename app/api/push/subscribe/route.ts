import { NextRequest, NextResponse } from "next/server";
import { getCtx } from "@/lib/session";
import { subscribe, unsubscribe, pushEnabled, vapidPublicKey, listSubscriptions } from "@/lib/push";

// The browser registers (or removes) its push subscription for the signed-in person.
export async function GET() {
  const ctx = await getCtx();
  if (!ctx) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  return NextResponse.json({ enabled: pushEnabled(), publicKey: vapidPublicKey(), devices: (await listSubscriptions(ctx.userId)).map((s) => ({ id: s.id, endpoint: s.endpoint, userAgent: s.userAgent, createdAt: s.createdAt })) });
}

export async function POST(req: NextRequest) {
  const ctx = await getCtx();
  if (!ctx) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!pushEnabled()) return NextResponse.json({ error: "Push is not configured on this deployment." }, { status: 503 });
  let body: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Body must be a PushSubscription JSON." }, { status: 400 }); }
  const r = await subscribe(ctx.userId, body as { endpoint: string; keys: { p256dh: string; auth: string } }, req.headers.get("user-agent") ?? "");
  return r.ok ? NextResponse.json({ ok: true, id: r.id }) : NextResponse.json({ error: r.error }, { status: 400 });
}

export async function DELETE(req: NextRequest) {
  const ctx = await getCtx();
  if (!ctx) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  let body: { endpoint?: string; id?: string };
  try { body = await req.json(); } catch { body = {}; }
  const key = body.endpoint ?? body.id;
  if (key) await unsubscribe(ctx.userId, key);
  return NextResponse.json({ ok: true });
}
