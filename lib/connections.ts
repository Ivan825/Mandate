import { and, desc, eq, isNull } from "drizzle-orm";
import { db, schema } from "./db";
import { recordEvent } from "./ledger";

// Agents connected through OAuth (MCP). Listing and revocation live here so
// the Settings page can show "who is connected" and cut one off.

export type ConnectedAgent = { clientId: string; name: string; uri: string | null; scopes: string[]; grantedAt: Date; activeTokens: number };

export async function listConnectedAgents(userId: string): Promise<ConnectedAgent[]> {
  const consents = await db.select({ c: schema.oauthConsent, name: schema.oauthClient.name, uri: schema.oauthClient.uri })
    .from(schema.oauthConsent).innerJoin(schema.oauthClient, eq(schema.oauthClient.clientId, schema.oauthConsent.clientId))
    .where(eq(schema.oauthConsent.userId, userId)).orderBy(desc(schema.oauthConsent.createdAt));
  const out: ConnectedAgent[] = [];
  for (const { c, name, uri } of consents) {
    if (!c.clientId) continue;
    const tokens = await db.select({ id: schema.oauthAccessToken.id }).from(schema.oauthAccessToken)
      .where(and(eq(schema.oauthAccessToken.userId, userId), eq(schema.oauthAccessToken.clientId, c.clientId), isNull(schema.oauthAccessToken.revoked)));
    out.push({ clientId: c.clientId, name: name ?? c.clientId, uri: uri ?? null, scopes: c.scopes ?? [], grantedAt: c.createdAt, activeTokens: tokens.length });
  }
  return out;
}

export async function revokeConnectedAgent(userId: string, clientId: string, workspaceId?: string) {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.update(schema.oauthAccessToken).set({ revoked: now }).where(and(eq(schema.oauthAccessToken.userId, userId), eq(schema.oauthAccessToken.clientId, clientId), isNull(schema.oauthAccessToken.revoked)));
    await tx.update(schema.oauthRefreshToken).set({ revoked: now }).where(and(eq(schema.oauthRefreshToken.userId, userId), eq(schema.oauthRefreshToken.clientId, clientId), isNull(schema.oauthRefreshToken.revoked)));
    await tx.delete(schema.oauthConsent).where(and(eq(schema.oauthConsent.userId, userId), eq(schema.oauthConsent.clientId, clientId)));
  });
  if (workspaceId) await recordEvent(workspaceId, "agent.disconnected", { clientId, by: userId });
}
