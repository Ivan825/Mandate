import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { auth } from "./auth";
import { db, schema } from "./db";
import type { Role } from "./roles";

// The one place pages and actions learn who is asking, which workspace they
// are in, and what they may do there. Everything downstream takes
// workspaceId explicitly; permission checks go through `can`.

export type Ctx = { userId: string; email: string; name: string; workspaceId: string; workspaceName: string; role: Role };

export type Permission = Partial<{
  agent: ("create")[]; mandate: ("issue" | "revoke" | "try")[]; approval: ("decide")[];
  ledger: ("export")[]; workspace: ("settings")[]; proxy: ("manage")[];
  member: ("create" | "update" | "delete")[]; invitation: ("create" | "cancel")[]; organization: ("update" | "delete")[];
}>;

async function membership(userId: string, ws: string) {
  const [m] = await db.select({ role: schema.member.role, name: schema.organization.name }).from(schema.member)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
    .where(and(eq(schema.member.userId, userId), eq(schema.member.organizationId, ws))).limit(1);
  return m ?? null;
}

export async function getCtx(): Promise<Ctx | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;
  let ws = session.session.activeOrganizationId ?? null;
  let m = ws ? await membership(session.user.id, ws) : null;
  if (!m) {
    // The session points at a workspace this person no longer belongs to
    // (removed, or the workspace was deleted). Move them to one they do.
    ws = await pickWorkspace(session.user.id, session.user.name, session.user.email);
    m = ws ? await membership(session.user.id, ws) : null;
    if (!ws || !m) return null;
  }
  const role = (m.role.split(",")[0] as Role) ?? "viewer";
  return { userId: session.user.id, email: session.user.email, name: session.user.name ?? "", workspaceId: ws!, workspaceName: m.name, role };
}

export async function requireCtx(): Promise<Ctx> {
  const ctx = await getCtx();
  if (!ctx) redirect("/sign-in");
  return ctx;
}

export async function can(perm: Permission): Promise<boolean> {
  try {
    const r = await auth.api.hasPermission({ headers: await headers(), body: { permissions: perm as Record<string, string[]> } });
    return Boolean(r?.success);
  } catch {
    return false;
  }
}

export class Forbidden extends Error { constructor(what: string) { super(`Your role does not allow: ${what}.`); } }

// A role that may not do something is told so on the exposure page rather
// than shown a generic error: the buttons are hidden for such roles, so this
// only fires on a stale page or a hand-built request.
export async function requirePermission(perm: Permission, what: string): Promise<Ctx> {
  const ctx = await requireCtx();
  if (!(await can(perm))) redirect("/?error=" + encodeURIComponent(`Your role in ${ctx.workspaceName} (${ctx.role}) does not allow ${what}.`));
  return ctx;
}

// Choose a workspace for this person and make it the session's active one:
// their most recent membership, or a fresh personal workspace if none.
async function pickWorkspace(userId: string, name: string | null | undefined, email: string): Promise<string | null> {
  const [m] = await db.select({ orgId: schema.member.organizationId }).from(schema.member).where(eq(schema.member.userId, userId)).orderBy(desc(schema.member.createdAt)).limit(1);
  let orgId = m?.orgId;
  if (!orgId) {
    const label = (name?.trim() || email.split("@")[0]).slice(0, 40);
    try {
      const org = await auth.api.createOrganization({ body: { name: `${label}'s workspace`, slug: `ws-${userId.slice(0, 8).toLowerCase()}-${Date.now().toString(36)}` }, headers: await headers() });
      orgId = org?.id;
    } catch (e) { console.error("could not create a personal workspace:", (e as Error).message); return null; }
  }
  if (!orgId) return null;
  try { await auth.api.setActiveOrganization({ body: { organizationId: orgId }, headers: await headers() }); } catch { /* cookie may be unsettable during render; the next request repeats this */ }
  return orgId;
}

// After leaving or deleting a workspace, point the session at another one
// the user belongs to, creating a personal workspace if none is left.
export async function ensureActiveWorkspace() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return;
  await pickWorkspace(session.user.id, session.user.name, session.user.email);
}
