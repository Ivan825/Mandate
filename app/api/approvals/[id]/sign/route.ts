import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getCtx, can } from "@/lib/session";
import { db, schema } from "@/lib/db";
import { challengeFor, verifyHumanSignature, rpId } from "@/lib/human-sign";
import { decideApproval, getApproval } from "@/lib/service";

// Human-signed decision on a pending approval.
//   GET  /api/approvals/:id/sign?d=approve   → WebAuthn request options (challenge commits to the decision)
//   POST /api/approvals/:id/sign            { d, assertion }  → verify and decide
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const c = await getCtx();
  if (!c) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!(await can({ approval: ["decide"] }))) return NextResponse.json({ error: "Your role cannot decide requests." }, { status: 403 });
  const { id } = await ctx.params;
  const d = req.nextUrl.searchParams.get("d") === "deny" ? "deny" : "approve";
  const a = await getApproval(id);
  if (!a || a.a.workspaceId !== c.workspaceId) return NextResponse.json({ error: "No such request." }, { status: 404 });
  const keys = await db.select({ id: schema.passkey.credentialID, transports: schema.passkey.transports }).from(schema.passkey).where(and(eq(schema.passkey.userId, c.userId)));
  if (keys.length === 0) return NextResponse.json({ error: "no_passkey", message: "Add a passkey in Settings to sign approvals." }, { status: 412 });
  return NextResponse.json({
    publicKey: { challenge: challengeFor(id, d, c.userId), rpId: rpId(), timeout: 120_000, userVerification: "preferred", allowCredentials: keys.map((k) => ({ id: k.id, type: "public-key", transports: k.transports ? k.transports.split(",") : undefined })) },
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const c = await getCtx();
  if (!c) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!(await can({ approval: ["decide"] }))) return NextResponse.json({ error: "Your role cannot decide requests." }, { status: 403 });
  const { id } = await ctx.params;
  let body: { d?: string; assertion?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Body must be JSON." }, { status: 400 }); }
  const d = body.d === "deny" ? "deny" : "approve";
  if (!body.assertion || typeof body.assertion !== "object") return NextResponse.json({ error: "assertion is required." }, { status: 400 });
  const v = await verifyHumanSignature(c.userId, id, d, body.assertion as Parameters<typeof verifyHumanSignature>[3]);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  const r = await decideApproval(c.workspaceId, id, d === "approve" ? "approved" : "denied", `${c.email} (passkey)`, v.signature);
  if (!r) return NextResponse.json({ error: "This request was already decided." }, { status: 409 });
  return NextResponse.json({ ok: true, decision: r.status, signedWith: v.signature.credentialId });
}
