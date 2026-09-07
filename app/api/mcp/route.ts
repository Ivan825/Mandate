import { z } from "zod";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { requireMcpAuth } from "@better-auth/mcp";
import { and, eq } from "drizzle-orm";
import { auth, MCP_RESOURCE } from "@/lib/auth";
import { db, schema } from "@/lib/db";
import { listMandates, getMandate, factsFor, authorize, reserveIdempotent, completeIdempotent, releaseIdempotent, MAX_AMOUNT } from "@/lib/service";
import { grantedWorkspace, isTokenRevoked } from "@/lib/connections";
import { fmt, parseList } from "@/lib/policy";

// Mandate as a remote MCP server. An agent connects with OAuth (the person
// approves it once on the consent page) and gets three tools. Every call is
// scoped to the person's workspace; every purchase goes through the same
// policy engine and ledger as the REST API and the card.

export const maxDuration = 30;

type Principal = { userId: string; workspaceId: string; clientId: string; clientName: string; scopes: Set<string>; canSpend: boolean };

// Who is calling, and on whose behalf. The workspace is the one the person
// bound on the consent page (never "whichever membership is newest"); the
// role is read live so a member demoted or removed since loses access at
// once; a disconnected client is refused even while its JWT is unexpired.
async function principalFrom(claims: Record<string, unknown>): Promise<Principal | { error: string }> {
  const userId = typeof claims.sub === "string" ? claims.sub : null;
  if (!userId) return { error: "Token has no subject." };
  const clientId = typeof claims.client_id === "string" ? claims.client_id : typeof claims.azp === "string" ? claims.azp : null;
  if (!clientId) return { error: "Token has no client." };
  const scopeStr = typeof claims.scope === "string" ? claims.scope : "";
  const jti = typeof claims.jti === "string" ? claims.jti : null;
  if (await isTokenRevoked(jti, userId, clientId)) return { error: "This agent was disconnected. Connect it again from your MCP client." };
  const grant = await grantedWorkspace(userId, clientId);
  if (!grant) return { error: "This connection is not bound to a workspace. Disconnect the agent in Settings and connect it again." };
  // A token minted before the current binding belongs to an earlier
  // connection (disconnected, then connected again): it stays dead.
  const iat = typeof claims.iat === "number" ? claims.iat * 1000 : 0;
  if (iat && iat < grant.boundAt.getTime() - 30_000) return { error: "This token predates the agent's current connection. Reconnect the agent." };
  const workspaceId = grant.workspaceId;
  const [m] = await db.select({ role: schema.member.role }).from(schema.member).where(and(eq(schema.member.userId, userId), eq(schema.member.organizationId, workspaceId))).limit(1);
  if (!m) return { error: "You are no longer a member of the workspace this agent was connected to." };
  const role = m.role.split(",")[0];
  const canSpend = role === "owner" || role === "admin";
  const [client] = await db.select({ name: schema.oauthClient.name }).from(schema.oauthClient).where(eq(schema.oauthClient.clientId, clientId)).limit(1);
  return { userId, workspaceId, clientId, clientName: client?.name ?? clientId, scopes: new Set(scopeStr.split(/\s+/).filter(Boolean)), canSpend };
}

function text(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

function buildServer(p: Principal) {
  const server = new McpServer({ name: "mandate", version: "0.3.0" });

  server.registerTool("list_mandates", {
    description: "List the active spending mandates in the connected workspace: each mandate's limits, what is left today and overall, allowed merchants and hours. Call this first to pick the mandate a purchase should go under.",
    inputSchema: z.object({}),
  }, async () => {
    const rows = await listMandates(p.workspaceId, true);
    const out = [];
    for (const { m, agentName } of rows) {
      const f = await factsFor(m);
      out.push({
        mandateId: m.id, name: m.name, agent: agentName, currency: m.currency,
        limits: { perTransaction: m.perTxnLimit, daily: m.dailyLimit, total: m.totalLimit, approvalAbove: m.approvalAbove },
        remaining: { today: Math.max(0, m.dailyLimit - f.spentToday), total: Math.max(0, m.totalLimit - f.spentTotal), todayDisplay: fmt(Math.max(0, m.dailyLimit - f.spentToday), m.currency) },
        scope: { allowedMerchants: parseList(m.allowedMerchants), blockedCategories: parseList(m.blockedCategories), activeHours: [m.activeHoursStart, m.activeHoursEnd], timezone: m.timezone },
        expiresAt: m.expiresAt,
      });
    }
    return text({ workspace: p.workspaceId, mandates: out, note: "Amounts are integers in minor units (cents, paise)." });
  });

  server.registerTool("check_mandate", {
    description: "Read one mandate's terms and remaining budget before planning a purchase.",
    inputSchema: z.object({ mandateId: z.string().describe("From list_mandates") }),
  }, async ({ mandateId }) => {
    const m = await getMandate(p.workspaceId, mandateId);
    if (!m) return { ...text({ error: "No such mandate in this workspace." }), isError: true };
    const f = await factsFor(m);
    return text({
      mandateId: m.id, name: m.name, status: m.status, currency: m.currency,
      limits: { perTransaction: m.perTxnLimit, daily: m.dailyLimit, total: m.totalLimit, approvalAbove: m.approvalAbove },
      remaining: { today: Math.max(0, m.dailyLimit - f.spentToday), total: Math.max(0, m.totalLimit - f.spentTotal) },
      scope: { allowedMerchants: parseList(m.allowedMerchants), blockedCategories: parseList(m.blockedCategories), activeHours: [m.activeHoursStart, m.activeHoursEnd], timezone: m.timezone },
      pendingApprovals: f.openPending, expiresAt: m.expiresAt,
    });
  });

  server.registerTool("request_purchase", {
    description: "Ask for authorisation to spend under a mandate BEFORE paying. amount is an integer in minor units (1299 = $12.99). Returns approved, declined (with the rule and reason), or pending — pending means the owner has been notified and must approve; tell the user, wait, then retry the identical request with the same idempotencyKey.",
    inputSchema: z.object({
      mandateId: z.string(),
      amount: z.number().int().positive(),
      merchant: z.string().min(1).max(120),
      purpose: z.string().max(300).optional().describe("One line the owner will read"),
      category: z.string().max(64).optional(),
      idempotencyKey: z.string().max(128).optional().describe("Reuse on retries so a network error never double-spends"),
    }),
  }, async ({ mandateId, amount, merchant, purpose, category, idempotencyKey }) => {
    if (!p.scopes.has("mandate:spend")) return { ...text({ error: "This connection was granted read-only access (mandate:read). Reconnect with the mandate:spend scope." }), isError: true };
    if (!p.canSpend) return { ...text({ error: "The person who connected this agent is not an owner or admin of the workspace, so it may read mandates but not spend under them." }), isError: true };
    if (amount > MAX_AMOUNT) return { ...text({ error: `amount must be at most ${MAX_AMOUNT} minor units.` }), isError: true };
    const m = await getMandate(p.workspaceId, mandateId);
    if (!m) return { ...text({ error: "No such mandate in this workspace." }), isError: true };
    const key = idempotencyKey ? `mcp:${idempotencyKey}` : null;
    if (key) {
      const res = await reserveIdempotent(m.id, key);
      if (res.kind === "replay") return text({ ...JSON.parse(res.response), replayed: true });
      if (res.kind === "in_progress") return { ...text({ error: "A request with this idempotencyKey is still being decided. Retry in a moment." }), isError: true };
    }
    let r;
    try {
      r = await authorize(m, { amount, merchant, purpose, category }, "mcp", { actor: p.clientName });
    } catch (e) {
      if (key) await releaseIdempotent(m.id, key).catch(() => {});
      throw e;
    }
    const body: Record<string, unknown> = {
      decision: r.decision, reason: r.reason, rule: r.rule, transactionId: r.transactionId, approvalId: r.approvalId ?? null,
      ownerNotified: r.notified ?? false,
      next: r.decision === "pending" ? "Tell the user their approval is needed, wait, then call request_purchase again with the same arguments." : undefined,
    };
    // Record the committed decision before anything else can fail.
    if (key) { if (r.decision === "pending") await releaseIdempotent(m.id, key); else await completeIdempotent(m.id, key, r.decision === "declined" ? 403 : 200, body); }
    try {
      const f = await factsFor(m);
      body.remaining = { today: Math.max(0, m.dailyLimit - f.spentToday), total: Math.max(0, m.totalLimit - f.spentTotal), currency: m.currency };
      if (key && r.decision !== "pending") await completeIdempotent(m.id, key, r.decision === "declined" ? 403 : 200, body);
    } catch { /* remaining is informational */ }
    return { ...text(body), isError: false };
  });

  return server;
}

const handler = createMcpHandler(async (ctx) => {
  const extra = (ctx.authInfo?.extra ?? {}) as { principal?: Principal };
  if (!extra.principal) throw new Error("unauthenticated");
  return buildServer(extra.principal);
}, { legacy: "stateless" });

const protectedHandler = requireMcpAuth(auth, async (request, claims) => {
  const principal = await principalFrom(claims as Record<string, unknown>);
  if ("error" in principal) return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: principal.error }, id: null }), { status: 403, headers: { "content-type": "application/json" } });
  return handler.fetch(request, {
    authInfo: { token: "", clientId: principal.clientId, scopes: [...principal.scopes], resource: new URL(MCP_RESOURCE), extra: { principal } },
  });
}, { resource: MCP_RESOURCE, requiredScopes: ["mandate:read"], challengeScopes: ["mandate:read", "mandate:spend"] });

export const POST = protectedHandler;
export const GET = protectedHandler;
export const DELETE = protectedHandler;
