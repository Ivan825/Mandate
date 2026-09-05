import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { getCtx } from "@/lib/session";
import { acceptInvitationAction } from "@/app/actions";

export default async function InvitePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const { id } = await params;
  const { error } = await searchParams;
  const ctx = await getCtx();
  if (!ctx) redirect(`/sign-in?next=${encodeURIComponent(`/invite/${id}`)}`);
  const [inv] = await db.select({ i: schema.invitation, org: schema.organization.name }).from(schema.invitation)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.invitation.organizationId)).where(eq(schema.invitation.id, id)).limit(1);
  const [inviter] = inv ? await db.select({ name: schema.user.name, email: schema.user.email }).from(schema.user).where(eq(schema.user.id, inv.i.inviterId)).limit(1) : [];
  const expired = inv && new Date() > new Date(inv.i.expiresAt);
  const mismatch = inv && inv.i.email.toLowerCase() !== ctx.email.toLowerCase();
  return (
    <div style={{ maxWidth: 480, margin: "48px auto" }}>
      <div className="eyebrow">Invitation</div>
      {!inv ? <h1>This invitation doesn't exist</h1> : (
        <>
          <h1 style={{ margin: "6px 0 8px" }}>Join {inv.org}</h1>
          <p className="muted">{inviter?.name || inviter?.email} invited <strong>{inv.i.email}</strong> as <strong>{inv.i.role}</strong>.</p>
          <div className="card stack">
            {error && <div className="notice bad">{error}</div>}
            {inv.i.status !== "pending" && <div className="notice">This invitation was already {inv.i.status}.</div>}
            {expired && inv.i.status === "pending" && <div className="notice bad">This invitation has expired. Ask for a new one.</div>}
            {mismatch && <div className="notice bad">You're signed in as {ctx.email}, but the invitation is for {inv.i.email}. Sign out and sign in with that address.</div>}
            {inv.i.status === "pending" && !expired && !mismatch && (
              <form action={acceptInvitationAction} className="actions"><input type="hidden" name="invitationId" value={id} /><button className="btn accent" type="submit">Accept and open the workspace</button></form>
            )}
          </div>
        </>
      )}
    </div>
  );
}
