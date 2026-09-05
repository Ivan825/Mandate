import Link from "next/link";
import { headers } from "next/headers";
import { requireCtx, can } from "@/lib/session";
import { auth } from "@/lib/auth";
import { ROLE_LABELS, ASSIGNABLE_ROLES, type Role } from "@/lib/roles";
import { When } from "@/app/components";
import { inviteMemberAction, cancelInvitationAction, updateMemberRoleAction, removeMemberAction } from "@/app/actions";

export default async function MembersPage({ searchParams }: { searchParams: Promise<{ invited?: string; error?: string; created?: string }> }) {
  const ctx = await requireCtx();
  const { invited, error, created } = await searchParams;
  const h = await headers();
  const [members, invitations, mayInvite, mayManage] = await Promise.all([
    auth.api.listMembers({ query: { organizationId: ctx.workspaceId, limit: 100 }, headers: h }),
    auth.api.listInvitations({ query: { organizationId: ctx.workspaceId }, headers: h }).catch(() => []),
    can({ invitation: ["create"] }),
    can({ member: ["update", "delete"] }),
  ]);
  const pending = (invitations as { id: string; email: string; role: string; status: string; expiresAt: Date | string }[]).filter((i) => i.status === "pending");

  return (
    <div style={{ maxWidth: 820 }}>
      <div className="page-head">
        <div>
          <div className="eyebrow">Workspace · {ctx.workspaceName}</div>
          <h1>Who can act in this workspace</h1>
          <p className="muted">Approvers decide requests from the inbox; admins also issue and revoke mandates and add agents; viewers only look. Everyone here gets notified of requests according to their own channels.</p>
        </div>
        <div className="actions"><Link href="/workspaces/new" className="btn secondary">New workspace</Link></div>
      </div>

      {created && <div className="notice ok" style={{ marginBottom: 14 }}>Workspace created. You're its owner; invite the people who should approve.</div>}
      {invited && <div className="notice ok" style={{ marginBottom: 14 }}>Invitation sent to {invited}. It's valid for 7 days.</div>}
      {error && <div className="notice bad" style={{ marginBottom: 14 }}>{error}</div>}

      <div className="tbl" style={{ marginBottom: 24 }}>
        <table>
          <thead><tr><th>Member</th><th>Role</th><th>Since</th><th></th></tr></thead>
          <tbody>
            {members.members.map((m) => {
              const role = (m.role.split(",")[0] as Role);
              const isSelf = m.userId === ctx.userId;
              return (
                <tr key={m.id}>
                  <td>{m.user.name || m.user.email}<div className="faint" style={{ fontSize: 12 }}>{m.user.email}{isSelf && " · you"}</div></td>
                  <td>
                    {mayManage && role !== "owner" && !isSelf ? (
                      <form action={updateMemberRoleAction} className="actions">
                        <input type="hidden" name="memberId" value={m.id} />
                        <select name="role" defaultValue={role} style={{ width: "auto" }}>
                          {ASSIGNABLE_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                        </select>
                        <button className="btn secondary sm" type="submit">Change</button>
                      </form>
                    ) : <span title={ROLE_LABELS[role] ?? role}>{role}</span>}
                  </td>
                  <td><When d={m.createdAt} /></td>
                  <td>{mayManage && role !== "owner" && !isSelf && (
                    <form action={removeMemberAction}><input type="hidden" name="memberId" value={m.id} /><button className="btn danger sm" type="submit">Remove</button></form>
                  )}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {pending.length > 0 && (
        <>
          <h2 style={{ marginBottom: 8 }}>Invited, not yet joined</h2>
          <div className="tbl" style={{ marginBottom: 24 }}>
            <table>
              <thead><tr><th>Email</th><th>Role</th><th>Expires</th><th></th></tr></thead>
              <tbody>
                {pending.map((i) => (
                  <tr key={i.id}><td>{i.email}</td><td>{i.role}</td><td><When d={i.expiresAt} /></td><td>{mayInvite && <form action={cancelInvitationAction}><input type="hidden" name="invitationId" value={i.id} /><button className="btn secondary sm" type="submit">Cancel</button></form>}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {mayInvite ? (
        <form action={inviteMemberAction} className="card form" style={{ maxWidth: 520 }}>
          <div className="eyebrow">Invite someone</div>
          <div className="row">
            <div className="field"><label htmlFor="email">Email</label><input id="email" name="email" type="email" required placeholder="partner@example.com" /></div>
            <div className="field"><label htmlFor="role">Role</label>
              <select id="role" name="role" defaultValue="approver">{ASSIGNABLE_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select>
            </div>
          </div>
          <div className="actions"><button className="btn accent" type="submit">Send invitation</button></div>
        </form>
      ) : <p className="faint">Only owners and admins can invite.</p>}
    </div>
  );
}
