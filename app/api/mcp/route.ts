import { z } from "zod";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { requireMcpAuth } from "@better-auth/mcp";
import { and, desc, eq } from "drizzle-orm";
import { auth, MCP_RESOURCE } from "@/lib/auth";
import { db, schema } from "@/lib/db";
import { listMandates, getMandate, factsFor, authorize, getIdempotent, putIdempotent } from "@/lib/service";
import { fmt, parseList } from "@/lib/policy";

// Mandate as a remote MCP server. An agent connects with OAuth (the person
// approves it once on the consent page) and gets three tools. Every call is
// scoped to the person's workspace; every purchase goes through the same
// policy engine and ledger as the REST API and the card.

export const maxDuration = 30;

type Principal = { userId: string; workspaceId: string; clientId: string; clientName: string; scopes: Set<string> };

async function principalFrom(claims: Record<string, unknown>): Promise<Principal | null> {
  const userId = typeof claims.sub === "string" ? claims.sub : null;
  if (!userId) return null;
  const clientId = typeof claims.client_id === "string" ? claims.client_id : typeof claims.azp === "string" ? claims.azp : "unknown-client";
  const scopeStr = typeof claims.scope === "string" ? claims.scope : "";
  const [m] = await db.select({ orgId: schema.member.organizationId }).from(schema.member).where(eq(schema.member.userId, userId)).orderBy(desc(schema.member.createdAt)).limit(1);
  if (!m) return null;
  const [client] = await db.select({ name: schema.oauthClient.name }).from(schema.oauthClient).where(eq(schema.oauthClient.clientId, clientId)).limit(1);
  return { userId, workspaceId: m.orgId, clientId, clientName: client?.name ?? clientId, scopes: new Set(scopeStr.split(/\s+/).filter(Boolean)) };
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
    const m = await getMandate(p.workspaceId, mandateId);
    if (!m) return { ...text({ error: "No such mandate in this workspace." }), isError: true };
    if (idempotencyKey) {
      const prior = await getIdempotent(m.id, `mcp:${idempotencyKey}`);
      if (prior) return text({ ...JSON.parse(prior.response), replayed: true });
    }
    const r = await authorize(m, { amount, merchant, purpose, category }, "mcp", { actor: p.clientName });
    const f = await factsFor(m);
    const body = {
      decision: r.decision, reason: r.reason, rule: r.rule, transactionId: r.transactionId, approvalId: r.approvalId ?? null,
      remaining: { today: Math.max(0, m.dailyLimit - f.spentToday), total: Math.max(0, m.totalLimit - f.spentTotal), currency: m.currency },
      ownerNotified: r.notified ?? false,
      next: r.decision === "pending" ? "Tell the user their approval is needed, wait, then call request_purchase again with the same arguments." : undefined,
    };
    if (idempotencyKey) await putIdempotent(m.id, `mcp:${idempotencyKey}`, r.decision === "declined" ? 403 : r.decision === "pending" ? 202 : 200, body);
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
  if (!principal) return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "No workspace for this user." }, id: null }), { status: 403, headers: { "content-type": "application/json" } });
  return handler.fetch(request, {
    authInfo: { token: "", clientId: principal.clientId, scopes: [...principal.scopes], resource: new URL(MCP_RESOURCE), extra: { principal } },
  });
}, { resource: MCP_RESOURCE, requiredScopes: ["mandate:read"], challengeScopes: ["mandate:read", "mandate:spend"] });

export const POST = protectedHandler;
export const GET = protectedHandler;
export const DELETE = protectedHandler;
