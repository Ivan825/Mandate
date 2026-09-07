import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { nextCookies } from "better-auth/next-js";
import { organization, magicLink, jwt } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { mcp } from "@better-auth/mcp";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { db, pool } from "./db";
import * as schema from "./schema";
import { sendMagicLinkEmail, sendInvitationEmail } from "./email";
import { ac, roles } from "./roles";
import { appUrl } from "./env";

// Who may sign in, how, and what an "account" is.
//
// - Sign-in: Google, passwordless email link, passkeys. No passwords to leak.
// - Workspaces: every user gets a personal organisation on first sign-in; the
//   session carries the active one and every query is scoped to it.
// - Agents: Mandate is an OAuth 2.1 authorisation server for MCP clients, so
//   Claude, ChatGPT or Cursor can "Connect Mandate" and receive scoped tokens
//   without anyone copying secrets into config files.

const baseURL = appUrl();
const rpID = (() => { try { return new URL(baseURL).hostname; } catch { return "localhost"; } })();

export const MCP_RESOURCE = `${baseURL.replace(/\/$/, "")}/api/mcp`;

export const auth = betterAuth({
  appName: "Mandate",
  baseURL,
  trustedOrigins: [baseURL],
  secret: process.env.BETTER_AUTH_SECRET ?? (process.env.NODE_ENV === "production" ? undefined : "dev-only-secret-change-me-please-32chars"),
  // AUTH_GEN=1 is used only by `npm run auth:generate`, before the drizzle
  // schema for these tables exists.
  database: process.env.AUTH_GEN === "1" ? pool : drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: { enabled: false },
  socialProviders: process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ? { google: { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET } }
    : {},
  session: {
    // No cookie cache: a revoked session must die on the very next request,
    // even at the cost of one database read per page.
    cookieCache: { enabled: false },
  },
  // Rate limits live in Postgres so they hold across serverless instances
  // (the default in-memory store resets on every cold start). Tighter rules
  // for the endpoints that send email or accept anonymous registrations.
  advanced: {
    // Same address resolution as lib/ratelimit.ts: the platform-set header
    // first, then a single-entry x-forwarded-for; a chain is trusted only
    // through TRUSTED_PROXIES (comma-separated CIDRs). Without a resolvable
    // address Better Auth falls back to one shared bucket, which is safe but
    // coarse — so set x-real-ip at your reverse proxy.
    ipAddress: {
      ipAddressHeaders: ["x-real-ip", "cf-connecting-ip", "x-forwarded-for"],
      trustedProxies: (process.env.TRUSTED_PROXIES ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    },
  },
  rateLimit: {
    enabled: true,
    storage: "database",
    window: 60,
    max: 120,
    customRules: {
      "/sign-in/magic-link": { window: 600, max: 10 },
      "/magic-link/verify": { window: 60, max: 10 },
      "/oauth2/register": { window: 3600, max: 20 },
      "/oauth2/token": { window: 60, max: 60 },
      "/organization/invite-member": { window: 3600, max: 20 },
    },
  },
  databaseHooks: {
    session: {
      create: {
        before: async (session) => {
          // A session always opens inside a workspace: the user's most recent
          // membership, or a personal workspace created right now.
          const ws = await ensurePersonalWorkspace(session.userId);
          return { data: { ...session, activeOrganizationId: ws } };
        },
      },
    },
  },
  plugins: [
    organization({
      ac,
      roles,
      allowUserToCreateOrganization: true,
      creatorRole: "owner",
      invitationExpiresIn: 60 * 60 * 24 * 7,
      sendInvitationEmail: async (data) => {
        await sendInvitationEmail({ to: data.email, inviter: data.inviter.user.name || data.inviter.user.email, workspace: data.organization.name, role: data.role, url: `${baseURL.replace(/\/$/, "")}/invite/${data.id}` });
      },
    }),
    magicLink({
      expiresIn: 60 * 15,
      sendMagicLink: async ({ email, url }) => { await sendMagicLinkEmail(email, url); },
    }),
    passkey({ rpID, rpName: "Mandate", origin: baseURL }),
    jwt(),
    mcp({
      loginPage: "/sign-in",
      consentPage: "/consent",
      resource: MCP_RESOURCE,
      scopes: ["mandate:read", "mandate:spend"],
      accessTokenExpiresIn: 60 * 60,
      // MCP clients register themselves: newer ones via client-ID metadata
      // documents (CIMD), older ones via RFC 7591 dynamic registration.
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
    }),
    cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
    nextCookies(),
  ],
});

export type Session = typeof auth.$Infer.Session;

// Find (or create) the workspace a session should open in.
async function ensurePersonalWorkspace(userId: string): Promise<string> {
  const { eq, desc } = await import("drizzle-orm");
  const [m] = await db.select({ orgId: schema.member.organizationId }).from(schema.member).where(eq(schema.member.userId, userId)).orderBy(desc(schema.member.createdAt)).limit(1);
  if (m) return m.orgId;
  const [u] = await db.select({ name: schema.user.name, email: schema.user.email }).from(schema.user).where(eq(schema.user.id, userId)).limit(1);
  const label = (u?.name?.trim() || u?.email?.split("@")[0] || "Personal").slice(0, 40);
  const slug = `ws-${userId.slice(0, 8).toLowerCase()}-${Date.now().toString(36)}`;
  const org = await auth.api.createOrganization({ body: { name: `${label}'s workspace`, slug, userId } });
  if (!org?.id) throw new Error("Could not create a workspace for this user.");
  return org.id;
}
