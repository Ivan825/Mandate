import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { db, schema, type Tx } from "./db";
import { MAX_AMOUNT } from "./money";
import { appendEvent } from "./ledger";
import { merchantMatches } from "./policy";
import type { ApprovalRoute } from "./schema";

// Approval routing: which members hear about which requests. Without a
// route every decider is asked (the household default). A team adds routes
// like "above 500 → finance", "category travel → ops lead", "mandate X →
// its owner". The first enabled route (lowest priority number) whose
// conditions all match wins; only its members are notified, and the inbox
// shows the request as theirs. Everyone who may decide can still decide —
// routing steers attention, it does not take authority away.

type Conn = Tx | typeof db;

export type RouteInput = { name: string; minAmount?: number | null; maxAmount?: number | null; category?: string; merchantPattern?: string; mandateId?: string | null; userIds: string[]; priority?: number };

export function parseUserIds(json: string): string[] { try { const v = JSON.parse(json); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } }

export function routeMatches(r: ApprovalRoute, req: { amount: number; category?: string; merchant: string; mandateId: string }): boolean {
  if (!r.enabled) return false;
  if (r.minAmount != null && req.amount < r.minAmount) return false;
  if (r.maxAmount != null && req.amount > r.maxAmount) return false;
  if (r.category && (req.category ?? "").toLowerCase() !== r.category.toLowerCase()) return false;
  if (r.merchantPattern && !merchantMatches(r.merchantPattern, req.merchant)) return false;
  if (r.mandateId && r.mandateId !== req.mandateId) return false;
  return true;
}

export async function listRoutes(workspaceId: string, conn: Conn = db): Promise<ApprovalRoute[]> {
  return conn.select().from(schema.approvalRoutes).where(eq(schema.approvalRoutes.workspaceId, workspaceId)).orderBy(asc(schema.approvalRoutes.priority), asc(schema.approvalRoutes.createdAt));
}

export async function routeFor(workspaceId: string, req: { amount: number; category?: string; merchant: string; mandateId: string }, conn: Conn = db): Promise<ApprovalRoute | null> {
  const routes = await listRoutes(workspaceId, conn);
  return routes.find((r) => routeMatches(r, req)) ?? null;
}

export const MAX_ROUTES = 50;
export async function addRoute(workspaceId: string, input: RouteInput, by: string): Promise<{ ok: true; route: ApprovalRoute } | { ok: false; error: string }> {
  const name = input.name.trim().slice(0, 60);
  if (!name) return { ok: false, error: "Give the route a name." };
  const userIds = [...new Set(input.userIds.filter(Boolean))].slice(0, 20);
  if (userIds.length === 0) return { ok: false, error: "Pick at least one member to route to." };
  // Only members who may decide can be routed to; anyone else would receive
  // requests they cannot act on.
  const members = await db.select({ userId: schema.member.userId, role: schema.member.role }).from(schema.member).where(eq(schema.member.organizationId, workspaceId));
  const deciders = new Set(members.filter((m) => /\b(owner|admin|approver)\b/.test(m.role)).map((m) => m.userId));
  const bad = userIds.filter((u) => !deciders.has(u));
  if (bad.length) return { ok: false, error: "Every member on a route must be an owner, admin or approver." };
  for (const [k, v] of [["minAmount", input.minAmount], ["maxAmount", input.maxAmount]] as const) if (v != null && (!Number.isInteger(v) || v < 0 || v > MAX_AMOUNT)) return { ok: false, error: `The ${k === "minAmount" ? "lower" : "upper"} amount must be a whole number of minor units below ${MAX_AMOUNT}.` };
  if (input.minAmount != null && input.maxAmount != null && input.minAmount > input.maxAmount) return { ok: false, error: "The amount band is upside down." };
  const existing = await db.select({ c: sql<number>`count(*)::int` }).from(schema.approvalRoutes).where(eq(schema.approvalRoutes.workspaceId, workspaceId));
  if ((existing[0]?.c ?? 0) >= MAX_ROUTES) return { ok: false, error: `A workspace can have at most ${MAX_ROUTES} routes; remove one first.` };
  const priority = Number.isInteger(input.priority) ? Math.min(Math.max(input.priority!, -100_000), 100_000) : 100;
  const row: ApprovalRoute = { id: randomUUID(), workspaceId, name, minAmount: input.minAmount ?? null, maxAmount: input.maxAmount ?? null, category: (input.category ?? "").trim().slice(0, 64), merchantPattern: (input.merchantPattern ?? "").trim().slice(0, 80), mandateId: input.mandateId ?? null, userIds: JSON.stringify(userIds), priority, enabled: 1, createdBy: by.slice(0, 120), createdAt: new Date() };
  await db.transaction(async (tx) => {
    await tx.insert(schema.approvalRoutes).values(row);
    await appendEvent(tx, workspaceId, "routing.added", { routeId: row.id, name, minAmount: row.minAmount, maxAmount: row.maxAmount, category: row.category, merchantPattern: row.merchantPattern, mandateId: row.mandateId, members: userIds.length, by });
  });
  return { ok: true, route: row };
}

export async function removeRoute(workspaceId: string, id: string, by: string) {
  await db.transaction(async (tx) => {
    const r = await tx.delete(schema.approvalRoutes).where(and(eq(schema.approvalRoutes.id, id), eq(schema.approvalRoutes.workspaceId, workspaceId))).returning({ name: schema.approvalRoutes.name });
    if (r.length) await appendEvent(tx, workspaceId, "routing.removed", { routeId: id, name: r[0].name, by });
  });
}

export async function toggleRoute(workspaceId: string, id: string, enabled: boolean, by: string) {
  await db.transaction(async (tx) => {
    const r = await tx.update(schema.approvalRoutes).set({ enabled: enabled ? 1 : 0 }).where(and(eq(schema.approvalRoutes.id, id), eq(schema.approvalRoutes.workspaceId, workspaceId))).returning({ name: schema.approvalRoutes.name });
    if (r.length) await appendEvent(tx, workspaceId, enabled ? "routing.enabled" : "routing.disabled", { routeId: id, name: r[0].name, by });
  });
}
