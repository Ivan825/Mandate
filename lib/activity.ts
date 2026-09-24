import { and, asc, desc, eq, gte, inArray, lte, lt, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, schema } from "./db";
import { fmt } from "./money";
import { FLAG_LABELS, type Flag } from "./anomaly";
import type { LedgerEvent, Note } from "./schema";

// The activity feed: the ledger, read as sentences. describeEvent turns a
// (type, payload) pair into one line a person can scan, plus enough
// structure to filter by; the same line goes into webhook envelopes and
// emails so everyone reads the same words.

export type Group = "decisions" | "approvals" | "mandates" | "agents" | "proxy" | "cards" | "workspace" | "webhooks" | "alerts" | "system";

export const GROUPS: { key: Group; label: string }[] = [
  { key: "decisions", label: "Decisions" }, { key: "approvals", label: "Approvals" }, { key: "mandates", label: "Mandates" }, { key: "agents", label: "Agents" },
  { key: "proxy", label: "API proxy" }, { key: "cards", label: "Cards & balance" }, { key: "workspace", label: "Workspace" }, { key: "webhooks", label: "Webhooks" }, { key: "alerts", label: "Alerts" },
];

export type Described = { summary: string; group: Group; tone: "ok" | "bad" | "warn" | "" ; mandateId?: string; agentId?: string; merchant?: string; amount?: number; currency?: string; outcome?: string };

type P = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v : "");
const n = (v: unknown) => (typeof v === "number" ? v : null);
const money = (p: P, key = "amount") => { const a = n(p[key]); const c = s(p.currency); return a != null && c ? fmt(a, c) : a != null ? String(a) : ""; };

export function groupOf(type: string): Group {
  if (type.startsWith("authorization.")) return "decisions";
  if (type.startsWith("approval.") || type.startsWith("plan.")) return "approvals";
  if (type.startsWith("mandate.card") || type.startsWith("stripe.") || type.startsWith("balance.")) return "cards";
  if (type.startsWith("mandate.")) return "mandates";
  if (type.startsWith("agent.")) return "agents";
  if (type.startsWith("proxy.")) return "proxy";
  if (type.startsWith("webhook.")) return "webhooks";
  if (type.startsWith("warning.")) return "alerts";
  if (type.startsWith("workspace.") || type.startsWith("member.") || type.startsWith("invitation.")) return "workspace";
  return "system";
}

export function flagSuffix(p: P): string {
  const f = Array.isArray(p.flags) ? (p.flags as unknown[]).filter((x): x is Flag => typeof x === "string" && x in FLAG_LABELS) : [];
  return f.length ? ` ⚑ ${f.map((x) => FLAG_LABELS[x].label).join(", ")}` : "";
}

export function describeEvent(type: string, p: P, names: { mandate?: string; agent?: string } = {}): Described {
  const d = describe(type, p, names);
  if (type.startsWith("authorization.") || type === "approval.requested") d.summary += flagSuffix(p);
  return d;
}

function describe(type: string, p: P, names: { mandate?: string; agent?: string } = {}): Described {
  const group = groupOf(type);
  const who = names.agent ? names.agent : "An agent";
  const m = names.mandate ? ` under ${names.mandate}` : "";
  const base: Described = { summary: type, group, tone: "", mandateId: s(p.mandateId) || undefined, agentId: s(p.agentId) || undefined, merchant: s(p.merchant) || undefined, amount: n(p.amount) ?? undefined, currency: s(p.currency) || undefined };
  const via = s(p.source) ? ` via ${s(p.source) === "agent_api" ? "the API" : s(p.source) === "mcp" ? `MCP${s(p.actor) ? ` (${s(p.actor)})` : ""}` : s(p.source)}` : "";
  switch (type) {
    case "authorization.approved": { const sh = p.shadow as { decision?: string; rule?: string } | undefined; return { ...base, outcome: "approved", tone: sh && sh.decision !== "approved" ? "warn" : "ok", summary: `${who} was allowed ${money(p)} at ${s(p.merchant)}${m}${via}${s(p.rule) === "plan" ? " — inside an approved plan" : s(p.rule) === "veto_passed" ? " — veto window passed" : ""}${p.settlement === "held" ? " — held until captured" : ""}${sh && sh.decision !== "approved" ? ` (shadow: would have ${sh.decision === "pending" ? "asked" : "declined"}, ${sh.rule})` : ""}.` }; }
    case "authorization.declined": return { ...base, outcome: "declined", tone: "bad", summary: `${who} was refused ${money(p)} at ${s(p.merchant)}${m}: ${s(p.reason)}` };
    case "authorization.pending": return { ...base, outcome: "pending", tone: "warn", summary: `${who} asked for ${money(p)} at ${s(p.merchant)}${m} — waiting for approval.` };
    case "authorization.captured": { const cap = n(p.capturedAmount), auth = n(p.authorizedAmount), rel = n(p.released) ?? 0; const c = s(p.currency); return { ...base, amount: cap ?? undefined, outcome: "captured", tone: "ok", summary: `${s(p.by) === "system" ? "Hold" : `${s(p.by) === "agent" ? who : s(p.by)} captured`}${s(p.by) === "system" ? " closed" : ""} ${cap != null && c ? fmt(cap, c) : ""} at ${s(p.merchant)}${rel > 0 && c ? ` (${fmt(rel, c)} of ${auth != null ? fmt(auth, c) : ""} released)` : ""}${s(p.reason) === "hold expired" ? " — hold expired, captured by policy" : ""}.` }; }
    case "authorization.voided": return { ...base, amount: n(p.authorizedAmount) ?? n(p.amount) ?? undefined, outcome: "voided", tone: "", summary: `${s(p.by) === "agent" ? who : s(p.by) || "Someone"} voided the ${n(p.authorizedAmount) != null && s(p.currency) ? fmt(n(p.authorizedAmount)!, s(p.currency)) : ""} hold at ${s(p.merchant)}${s(p.reason) ? ` — ${s(p.reason)}` : ""}.` };
    case "authorization.released": return { ...base, amount: n(p.authorizedAmount) ?? undefined, outcome: "released", tone: "", summary: `Hold of ${n(p.authorizedAmount) != null && s(p.currency) ? fmt(n(p.authorizedAmount)!, s(p.currency)) : ""} at ${s(p.merchant)} expired unsettled and was released${m}.` };
    case "authorization.settled": return { ...base, amount: n(p.actualAmount) ?? undefined, outcome: "captured", tone: "ok", summary: `Proxy call to ${s(p.provider)} (${s(p.model)}) settled at ${n(p.actualAmount) != null ? fmt(n(p.actualAmount)!, "USD") : ""}${n(p.estimatedAmount) != null ? ` (estimated ${fmt(n(p.estimatedAmount)!, "USD")})` : ""}.` };
    case "approval.requested": return s(p.kind) === "veto"
      ? { ...base, outcome: "pending", tone: "warn", summary: `${who} announced ${money(p)} at ${s(p.merchant)} — goes through at ${s(p.vetoUntil)} unless cancelled${s(p.purpose) ? ` (“${s(p.purpose)}”)` : ""}.` }
      : { ...base, outcome: "pending", tone: "warn", summary: `${who} asked you to approve ${money(p)} at ${s(p.merchant)}${s(p.purpose) ? ` — “${s(p.purpose)}”` : ""}.` };
    case "approval.approved": return s(p.by) === "silence"
      ? { ...base, outcome: "approved", tone: "ok", summary: `The veto window on ${money(p)} at ${s(p.merchant)} closed without objection.` }
      : { ...base, outcome: "approved", tone: "ok", summary: `${s(p.by) || "You"} approved ${money(p)} at ${s(p.merchant)}${m}${p.humanSigned ? " — signed with a passkey" : ""}.` };
    case "approval.denied": return { ...base, outcome: "denied", tone: "bad", summary: `${s(p.by) || "You"} ${s(p.kind) === "veto" ? "cancelled" : "denied"} ${money(p)} at ${s(p.merchant)}${m}${p.humanSigned ? " — signed with a passkey" : ""}.` };
    case "plan.proposed": return { ...base, outcome: "pending", tone: "warn", amount: n(p.totalMax) ?? undefined, summary: `${who} proposed a plan “${s(p.title)}”: ${Array.isArray(p.items) ? (p.items as unknown[]).length : "?"} items, up to ${money(p, "totalMax")}.` };
    case "plan.approved": return { ...base, outcome: "approved", tone: "ok", amount: n(p.totalMax) ?? undefined, summary: `${s(p.by) || "You"} approved the plan “${s(p.title)}” (up to ${money(p, "totalMax")}).` };
    case "plan.denied": return { ...base, outcome: "denied", tone: "bad", summary: `${s(p.by) || "You"} denied the plan “${s(p.title)}”.` };
    case "plan.completed": return { ...base, tone: "ok", summary: `Every item of the plan “${s(p.title)}” has been bought.` };
    case "plan.cancelled": return { ...base, tone: "", summary: `${s(p.by)} cancelled the plan “${s(p.title)}”.` };
    case "plan.expired": return { ...base, tone: "", summary: "A plan expired unused." };
    case "mandate.mode_changed": return { ...base, tone: "warn", summary: s(p.mode) === "observe" ? `${s(p.by)} switched the mandate to shadow mode: nothing is declined, verdicts are recorded.` : `${s(p.by)} switched the mandate to enforcing.` };
    case "mandate.autonomy_up": return { ...base, tone: "ok", summary: `Trust track: after ${n(p.after) ?? ""} clean decisions the per-transaction limit rose to ${n(p.perTxnNow) != null && s(p.currency) ? fmt(n(p.perTxnNow)!, s(p.currency)) : ""}.` };
    case "mandate.autonomy_down": return { ...base, tone: "warn", summary: s(p.by) ? `${s(p.by)} reset the trust track to probation.` : `Trust track stepped down (${s(p.reason)}); per-transaction limit now ${n(p.perTxnNow) != null && s(p.currency) ? fmt(n(p.perTxnNow)!, s(p.currency)) : ""}.` };
    case "approval.expired": return { ...base, outcome: "expired", tone: "", summary: `Request for ${money(p)} at ${s(p.merchant)} expired (${s(p.reason)}).` };
    case "approval.notified": return { ...base, tone: "", summary: `Approvers were notified (${Array.isArray(p.channels) ? (p.channels as { channel: string; ok: boolean }[]).map((c) => `${c.channel} ${c.ok ? "✓" : "✗"}`).join(", ") : ""}).` };
    case "mandate.issued": return { ...base, tone: "ok", summary: `Mandate “${s(p.name)}” issued: ${money(p, "perTxnLimit")} per purchase, ${money(p, "dailyLimit")} a day, ${money(p, "totalLimit")} in total${n(p.approvalAbove) != null ? `, ask above ${money(p, "approvalAbove")}` : ""}.` };
    case "mandate.revoked": return { ...base, tone: "bad", summary: `Mandate revoked by ${s(p.by) || "the owner"}. The agent is cut off.` };
    case "mandate.paused": return { ...base, tone: "warn", summary: `Mandate paused by ${s(p.by)}${s(p.until) ? ` until ${s(p.until)}` : " until further notice"}${s(p.reason) ? ` — ${s(p.reason)}` : ""}.` };
    case "mandate.resumed": return { ...base, tone: "ok", summary: s(p.by) === "system" ? "Mandate resumed: the pause ran out." : `Mandate resumed by ${s(p.by)}.` };
    case "mandate.raised": return { ...base, tone: "warn", summary: `${s(p.by)} raised ${s(p.field).replace("_", " ")} to ${n(p.amount) != null && s(p.currency) ? fmt(n(p.amount)!, s(p.currency)) : ""} until ${s(p.endsAt)}${s(p.reason) ? ` — ${s(p.reason)}` : ""}.` };
    case "mandate.raise_withdrawn": return { ...base, tone: "", summary: `${s(p.by)} withdrew the temporary ${s(p.field).replace("_", " ")} raise.` };
    case "mandate.card_issued": return { ...base, tone: "ok", summary: `Virtual card ···${s(p.last4)} issued to the mandate.` };
    case "mandate.card_frozen": return { ...base, tone: "warn", summary: `Card frozen by ${s(p.by)}.` };
    case "mandate.card_unfrozen": return { ...base, tone: "ok", summary: `Card unfrozen by ${s(p.by)}.` };
    case "mandate.card_revealed": return { ...base, tone: "", summary: `Card details revealed by ${s(p.by)}.` };
    case "agent.created": return { ...base, agentId: s(p.agentId) || undefined, tone: "", summary: `Agent “${s(p.name)}” added.` };
    case "proxy.provider_key_added": return { ...base, tone: "", summary: `${s(p.provider)} provider key (···${s(p.hint)}) stored by ${s(p.by)}.` };
    case "proxy.provider_key_removed": return { ...base, tone: "", summary: `Provider key removed by ${s(p.by)}.` };
    case "proxy.key_issued": return { ...base, tone: "ok", summary: `Proxy key “${s(p.name)}” issued for ${s(p.provider)}${m}.` };
    case "proxy.key_revoked": return { ...base, tone: "bad", summary: `Proxy key revoked by ${s(p.by)}.` };
    case "proxy.key_suspended": return { ...base, tone: "bad", summary: `Proxy key “${s(p.name)}” suspended: ${s(p.reason)}.` };
    case "stripe.capture": return { ...base, tone: "ok", summary: `Card capture of ${n(p.amount) ?? ""} reported by Stripe.` };
    case "stripe.reversal": return { ...base, tone: "", summary: "Card authorisation reversed by the network." };
    case "stripe.refund": return { ...base, tone: "ok", summary: `Refund of ${n(p.amount) ?? ""} from the merchant.` };
    case "stripe.closed": return { ...base, tone: "", summary: "Card authorisation closed." };
    case "stripe.card_status": return { ...base, tone: "warn", summary: `Stripe reports the card as ${s(p.status)}.` };
    case "balance.topup": return { ...base, tone: "ok", summary: `Balance topped up by ${money(p)} (${s(p.source)}).` };
    case "warning.fired": return { ...base, tone: "warn", summary: s(p.kind) === "daily_80" ? `${who} has used most of today's limit${m}.` : s(p.kind) === "total_80" ? `${who} has used most of its total sanction${m}.` : s(p.kind) === "velocity" ? `${who} is buying unusually fast (${n(p.count) ?? ""} approvals in ten minutes).` : `Alert: ${s(p.kind)}.` };
    case "workspace.ownership_transferred": return { ...base, tone: "warn", summary: `Ownership transferred by ${s(p.by)}.` };
    case "workspace.settings_changed": return { ...base, tone: "", summary: `Workspace settings changed by ${s(p.by)}${s(p.currency) ? ` (default currency ${s(p.currency)})` : ""}.` };
    case "webhook.endpoint_added": return { ...base, tone: "ok", summary: `Event webhook added for ${s(p.url)} by ${s(p.by)}.` };
    case "webhook.endpoint_removed": return { ...base, tone: "", summary: `Event webhook removed by ${s(p.by)}.` };
    case "webhook.endpoint_paused": return { ...base, tone: "warn", summary: `Event webhook paused by ${s(p.by)}.` };
    case "webhook.endpoint_enabled": return { ...base, tone: "ok", summary: `Event webhook re-enabled by ${s(p.by)}.` };
    case "webhook.endpoint_disabled": return { ...base, tone: "bad", summary: `Event webhook ${s(p.url)} disabled after ${n(p.failures) ?? ""} failures (${s(p.lastError)}).` };
    case "receipt.shared": return { ...base, tone: "", summary: `${s(p.by)} shared this decision's receipt publicly.` };
    case "receipt.unshared": return { ...base, tone: "", summary: `${s(p.by)} stopped sharing this decision's receipt.` };
    case "webhook.secret_rotated": return { ...base, tone: "", summary: `Webhook signing secret rotated by ${s(p.by)}.` };
    default: return { ...base, summary: type.replace(/[._]/g, " ") + "." };
  }
}

// ---------- Querying ----------

export type ActivityFilter = { q?: string; group?: Group | ""; outcome?: string; mandateId?: string; agentId?: string; from?: Date | null; to?: Date | null; before?: number | null; limit?: number };

export type ActivityRow = { e: LedgerEvent; d: Described; payload: P; notes: Note[] };

const TYPE_PREFIX: Record<Group, string[]> = {
  decisions: ["authorization."], approvals: ["approval."], mandates: ["mandate.issued", "mandate.revoked"], agents: ["agent."], proxy: ["proxy."],
  cards: ["mandate.card", "stripe.", "balance."], workspace: ["workspace.", "member.", "invitation."], webhooks: ["webhook."], alerts: ["warning."], system: [],
};

export async function listActivity(workspaceId: string, f: ActivityFilter = {}): Promise<{ rows: ActivityRow[]; more: boolean }> {
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  const conds = [eq(schema.ledger.workspaceId, workspaceId)];
  if (f.before) conds.push(lt(schema.ledger.seq, f.before));
  if (f.from) conds.push(gte(schema.ledger.createdAt, f.from));
  if (f.to) conds.push(lte(schema.ledger.createdAt, f.to));
  if (f.group && TYPE_PREFIX[f.group]?.length) conds.push(sql`(${sql.join(TYPE_PREFIX[f.group].map((p) => sql`${schema.ledger.type} like ${p + "%"}`), sql` or `)})`);
  if (f.outcome) {
    const map: Record<string, string[]> = { approved: ["authorization.approved", "approval.approved"], declined: ["authorization.declined", "approval.denied"], pending: ["authorization.pending", "approval.requested"], captured: ["authorization.captured", "authorization.settled"], voided: ["authorization.voided", "authorization.released"] };
    const types = map[f.outcome]; if (types) conds.push(sql`${schema.ledger.type} in (${sql.join(types.map((t) => sql`${t}`), sql`, `)})`);
  }
  if (f.mandateId) conds.push(sql`${schema.ledger.payload} like ${'%"mandateId":"' + f.mandateId + '"%'}`);
  if (f.agentId) conds.push(sql`${schema.ledger.payload} like ${'%"agentId":"' + f.agentId + '"%'}`);
  if (f.q?.trim()) { const q = "%" + f.q.trim().replace(/[%_\\]/g, (c) => "\\" + c).slice(0, 80) + "%"; conds.push(sql`(${schema.ledger.payload} ilike ${q} or ${schema.ledger.type} ilike ${q})`); }
  const rows = await db.select().from(schema.ledger).where(and(...conds)).orderBy(desc(schema.ledger.seq)).limit(limit + 1);
  const page = rows.slice(0, limit);
  const [mands, ags] = await Promise.all([
    db.select({ id: schema.mandates.id, name: schema.mandates.name, agentId: schema.mandates.agentId }).from(schema.mandates).where(eq(schema.mandates.workspaceId, workspaceId)),
    db.select({ id: schema.agents.id, name: schema.agents.name }).from(schema.agents).where(eq(schema.agents.workspaceId, workspaceId)),
  ]);
  const mandateName = new Map(mands.map((x) => [x.id, x.name]));
  const mandateAgent = new Map(mands.map((x) => [x.id, x.agentId]));
  const agentName = new Map(ags.map((x) => [x.id, x.name]));
  const targetIds = [...new Set(page.flatMap((e) => { const p = safe(e.payload); return [e.id, typeof p.transactionId === "string" ? p.transactionId : "", typeof p.approvalId === "string" ? p.approvalId : ""]; }).filter(Boolean))];
  const noteRows = targetIds.length ? await db.select().from(schema.notes).where(and(eq(schema.notes.workspaceId, workspaceId), inArray(schema.notes.targetId, targetIds))).orderBy(asc(schema.notes.createdAt)) : [];
  const out: ActivityRow[] = page.map((e) => {
    const payload = safe(e.payload);
    const mid = typeof payload.mandateId === "string" ? payload.mandateId : undefined;
    const aid = typeof payload.agentId === "string" ? payload.agentId : mid ? mandateAgent.get(mid) : undefined;
    const d = describeEvent(e.type, payload, { mandate: mid ? mandateName.get(mid) : undefined, agent: aid ? agentName.get(aid) : undefined });
    if (!d.agentId && aid) d.agentId = aid;
    const ids = new Set([e.id, typeof payload.transactionId === "string" ? payload.transactionId : "", typeof payload.approvalId === "string" ? payload.approvalId : ""].filter(Boolean));
    return { e, d, payload, notes: noteRows.filter((nt) => ids.has(nt.targetId)) };
  });
  return { rows: out, more: rows.length > limit };
}

function safe(json: string): P { try { const v = JSON.parse(json); return v && typeof v === "object" ? v : {}; } catch { return {}; } }

// ---------- Notes ----------

export async function addNote(workspaceId: string, target: { type: "transaction" | "approval" | "event"; id: string }, body: string, author: { id: string; email: string }): Promise<Note | null> {
  const text = body.trim().slice(0, 1000);
  if (!text) return null;
  const row: Note = { id: randomUUID(), workspaceId, targetType: target.type, targetId: target.id, body: text, authorId: author.id, authorEmail: author.email, createdAt: new Date() };
  await db.insert(schema.notes).values(row);
  return row;
}

export async function removeNote(workspaceId: string, id: string, authorId: string) {
  await db.delete(schema.notes).where(and(eq(schema.notes.id, id), eq(schema.notes.workspaceId, workspaceId), eq(schema.notes.authorId, authorId)));
}

export async function notesFor(workspaceId: string, targetIds: string[]): Promise<Note[]> {
  if (targetIds.length === 0) return [];
  return db.select().from(schema.notes).where(and(eq(schema.notes.workspaceId, workspaceId), inArray(schema.notes.targetId, targetIds))).orderBy(asc(schema.notes.createdAt));
}
