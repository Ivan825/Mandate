import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "./auth";

// The one place pages and actions learn who is asking and which workspace
// they are in. Everything downstream takes workspaceId explicitly.

export type Ctx = { userId: string; email: string; name: string; workspaceId: string };

export async function getCtx(): Promise<Ctx | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;
  const ws = session.session.activeOrganizationId;
  if (!ws) return null;
  return { userId: session.user.id, email: session.user.email, name: session.user.name ?? "", workspaceId: ws };
}

export async function requireCtx(): Promise<Ctx> {
  const ctx = await getCtx();
  if (!ctx) redirect("/sign-in");
  return ctx;
}
