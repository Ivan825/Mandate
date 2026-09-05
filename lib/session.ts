import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
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

export async function getCtx(): Promise<Ctx | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;
  const ws = session.session.activeOrganizationId;
  if (!ws) return null;
  const [m] = await db.select({ role: schema.member.role, name: schema.organization.name }).from(schema.member)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
    .where(and(eq(schema.member.userId, session.user.id), eq(schema.member.organizationId, ws))).limit(1);
  if (!m) return null;
  const role = (m.role.split(",")[0] as Role) ?? "viewer";
  return { userId: session.user.id, email: session.user.email, name: session.user.name ?? "", workspaceId: ws, workspaceName: m.name, role };
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

export async function requirePermission(perm: Permission, what: string): Promise<Ctx> {
  const ctx = await requireCtx();
  if (!(await can(perm))) throw new Forbidden(what);
  return ctx;
}
