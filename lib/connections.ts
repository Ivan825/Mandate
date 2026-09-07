import { and, desc, eq, isNull } from "drizzle-orm";
import { db, schema } from "./db";
import { recordEvent } from "./ledger";

// Agents connected through OAuth (MCP). Listing and revocation live here so
// the Settings page can show "who is connected" and cut one off, and the
// consent page can bind a client to the workspace the person was looking at.

export type ConnectedAgent = { clientId: string; name: string; uri: string | null; scopes: string[]; grantedAt: Date; activeTokens: number; workspaceId: string | null };

export async function listConnectedAgents(userId: string): Promise<ConnectedAgent[]> {
  const consents = await db.select({ c: schema.oauthConsent, name: schema.oauthClient.name, uri: schema.oauthClient.uri })
    .from(schema.oauthConsent).innerJoin(schema.oauthClient, eq(schema.oauthClient.clientId, schema.oauthConsent.clientId))
    .where(eq(schema.oauthConsent.userId, userId)).orderBy(desc(schema.oauthConsent.createdAt));
  const out: ConnectedAgent[] = [];
  for (const { c, name, uri } of consents) {
    if (!c.clientId) continue;
    const tokens = await db.select({ id: schema.oauthAccessToken.id }).from(schema.oauthAccessToken)
      .where(and(eq(schema.oauthAccessToken.userId, userId), eq(schema.oauthAccessToken.clientId, c.clientId), isNull(schema.oauthAccessToken.revoked)));
    const [g] = await db.select({ ws: schema.mcpGrants.workspaceId }).from(schema.mcpGrants).where(eq(schema.mcpGrants.id, `${userId}:${c.clientId}`)).limit(1);
    out.push({ clientId: c.clientId, name: name ?? c.clientId, uri: uri ?? null, scopes: c.scopes ?? [], grantedAt: c.createdAt, activeTokens: tokens.length, workspaceId: g?.ws ?? null });
  }
  return out;
}

// Called from the consent page just before the person clicks Allow: the
// client is bound to the session's active workspace, not to whichever
// membership happens to be newest when the agent later calls in.
export async function bindClientWorkspace(userId: string, clientId: string, workspaceId: string) {
  const now = new Date();
  await db.insert(schema.mcpGrants).values({ id: `${userId}:${clientId}`, userId, clientId, workspaceId, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: schema.mcpGrants.id, set: { workspaceId, updatedAt: now } });
}

export async function grantedWorkspace(userId: string, clientId: string): Promise<{ workspaceId: string; boundAt: Date } | null> {
  const [g] = await db.select({ ws: schema.mcpGrants.workspaceId, at: schema.mcpGrants.updatedAt }).from(schema.mcpGrants).where(eq(schema.mcpGrants.id, `${userId}:${clientId}`)).limit(1);
  return g ? { workspaceId: g.ws, boundAt: g.at } : null;
}

// Better Auth's bearer verification checks signature and expiry; revocation
// (Settings → Disconnect) is a row in oauth_access_token that the JWT alone
// cannot know about, so the MCP handler asks here on every call.
export async function isTokenRevoked(jti: string | null, userId: string, clientId: string): Promise<boolean> {
  if (jti) {
    const [t] = await db.select({ revoked: schema.oauthAccessToken.revoked }).from(schema.oauthAccessToken).where(eq(schema.oauthAccessToken.id, jti)).limit(1);
    if (t) return t.revoked !== null;
  }
  // No token row for this id: the client is connected only if consent still stands.
  const [c] = await db.select({ id: schema.oauthConsent.id }).from(schema.oauthConsent).where(and(eq(schema.oauthConsent.userId, userId), eq(schema.oauthConsent.clientId, clientId))).limit(1);
  return !c;
}

export async function revokeConnectedAgent(userId: string, clientId: string, workspaceId?: string) {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.update(schema.oauthAccessToken).set({ revoked: now }).where(and(eq(schema.oauthAccessToken.userId, userId), eq(schema.oauthAccessToken.clientId, clientId), isNull(schema.oauthAccessToken.revoked)));
    await tx.update(schema.oauthRefreshToken).set({ revoked: now }).where(and(eq(schema.oauthRefreshToken.userId, userId), eq(schema.oauthRefreshToken.clientId, clientId), isNull(schema.oauthRefreshToken.revoked)));
    await tx.delete(schema.oauthConsent).where(and(eq(schema.oauthConsent.userId, userId), eq(schema.oauthConsent.clientId, clientId)));
    await tx.delete(schema.mcpGrants).where(eq(schema.mcpGrants.id, `${userId}:${clientId}`));
  });
  if (workspaceId) await recordEvent(workspaceId, "agent.disconnected", { clientId, by: userId });
}
