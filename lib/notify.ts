import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPrivateAddress, isMetadataAddress } from "./net";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "./db";
import { fmt } from "./policy";
import { FLAG_LABELS, parseFlags } from "./anomaly";
import type { Approval, Mandate, Plan } from "./schema";
import { parsePlanItems } from "./policy";
import { parseUserIds } from "./routing";
import { appUrl, isProduction } from "./env";
import { sendMail } from "./mailer";
import { safeFetch } from "./safe-fetch";

// Notifications are fire-and-forget: they never delay or change a decision.
//
// Recipients: every member of the workspace whose role may decide requests
// (owner, admin, approver), through the channels they set in Settings:
//   email     — Resend or SMTP (lib/mailer.ts); else logged to the console
//   webhook   — POST JSON to any URL (n8n, Zapier, Make, your own service)
// If nobody in the workspace has a channel, the deployment-level fallback
// (NOTIFY_WEBHOOK_URL) is used, so a single-owner self-host works without
// any per-user setup.
//
// One-tap links are signed with NOTIFY_SECRET and expire with the request.

export const LINK_TTL_MS = 24 * 3600 * 1000;
export type ChannelType = "email" | "webhook" | "push";
export type Channel = { id: string; userId: string; type: ChannelType; target: string; label: string };

export function notifySecret(): string | null {
  return process.env.NOTIFY_SECRET ?? process.env.BETTER_AUTH_SECRET ?? null;
}
export function baseUrl(): string {
  return appUrl();
}

// A link is signed for one recipient: the token carries the user id inside
// the HMAC, so a decision made through it is that person's, is refused once
// they may no longer decide in that workspace, and counts as exactly one
// co-signature. Links with no recipient (the deployment-level fallback
// channel) still work for single-approver requests and are recorded as
// anonymous; they never satisfy a co-sign requirement.
export function signLink(approvalId: string, decision: "approve" | "deny", expMs: number, userId?: string | null): string | null {
  const secret = notifySecret();
  if (!secret) return null;
  const uid = userId ? Buffer.from(userId).toString("base64url") : "";
  const sig = createHmac("sha256", secret).update(`${approvalId}|${decision}|${expMs}|${uid}`).digest("base64url");
  return uid ? `${expMs}.u${uid}.${sig}` : `${expMs}.${sig}`;
}

export type LinkCheck = { ok: boolean; userId: string | null };

export function parseLink(approvalId: string, decision: "approve" | "deny", token: string): LinkCheck {
  const secret = notifySecret();
  if (!secret || typeof token !== "string" || token.length > 400) return { ok: false, userId: null };
  const parts = token.split(".");
  const expStr = parts[0];
  const uid = parts.length === 3 && parts[1].startsWith("u") ? parts[1].slice(1) : "";
  const sig = parts.length === 3 ? parts[2] : parts[1];
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp || !sig || (parts.length !== 2 && parts.length !== 3)) return { ok: false, userId: null };
  const expected = createHmac("sha256", secret).update(`${approvalId}|${decision}|${exp}|${uid}`).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, userId: null };
  return { ok: true, userId: uid ? Buffer.from(uid, "base64url").toString() : null };
}

export function verifyLink(approvalId: string, decision: "approve" | "deny", token: string): boolean { return parseLink(approvalId, decision, token).ok; }

export type Links = { approve: string; deny: string; inbox: string };

export function decisionLinks(approvalId: string, userId?: string | null): Links | null {
  const exp = Date.now() + LINK_TTL_MS;
  const a = signLink(approvalId, "approve", exp, userId);
  const d = signLink(approvalId, "deny", exp, userId);
  if (!a || !d) return null;
  return { approve: `${baseUrl()}/a/${approvalId}?d=approve&t=${a}`, deny: `${baseUrl()}/a/${approvalId}?d=deny&t=${d}`, inbox: `${baseUrl()}/approvals` };
}

// The person a one-tap link was issued to, if they may still decide in the
// request's workspace; null for an anonymous (fallback-channel) link.
export async function linkPrincipal(userId: string | null, workspaceId: string): Promise<{ userId: string; email: string } | null | "revoked"> {
  if (!userId) return null;
  const [m] = await db.select({ role: schema.member.role, email: schema.user.email }).from(schema.member).innerJoin(schema.user, eq(schema.user.id, schema.member.userId)).where(and(eq(schema.member.userId, userId), eq(schema.member.organizationId, workspaceId))).limit(1);
  if (!m || !/\b(owner|admin|approver)\b/.test(m.role)) return "revoked";
  return { userId, email: m.email };
}

// ---------- Channel storage ----------

export async function listChannels(userId: string): Promise<Channel[]> {
  const rows = await db.select().from(schema.notificationChannels).where(eq(schema.notificationChannels.userId, userId));
  return rows.map((r) => ({ id: r.id, userId: r.userId, type: r.type as ChannelType, target: r.target, label: r.label }));
}

// A webhook URL is fetched from our servers, so it must point at the public
// internet: no loopback, link-local, private ranges or cloud metadata
// addresses, and https only outside development. Checked when added and
// again at delivery time (a hostname can be re-pointed later).
// A self-hosted deployment whose n8n lives on the same private network sets
// WEBHOOK_ALLOW_PRIVATE=1 to lift the address check (never the URL check).
export function privateWebhooksAllowed(): boolean { return process.env.WEBHOOK_ALLOW_PRIVATE === "1"; }

export async function webhookProblem(raw: string, opts: { ignorePrivateFlag?: boolean } = {}): Promise<string | null> {
  let u: URL;
  try { u = new URL(raw); } catch { return "Enter a full http(s) URL."; }
  const privateOk = privateWebhooksAllowed() && !opts.ignorePrivateFlag;
  if (u.protocol !== "https:" && !(u.protocol === "http:" && (!isProduction() || privateOk))) return "Webhook URLs must use https.";
  if (u.username || u.password) return "Webhook URLs cannot carry credentials.";
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isMetadataHost(host)) return "That address is a cloud metadata service and can never be a target.";
  if (privateOk) return null;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return "Webhook URLs must be reachable on the public internet.";
  const addrs: string[] = [];
  if (isIP(host)) addrs.push(host);
  else {
    try { addrs.push(...(await lookup(host, { all: true })).map((a) => a.address)); } catch { return "That hostname does not resolve."; }
  }
  if (addrs.length === 0 || addrs.some(isPrivateAddress)) return "Webhook URLs must be reachable on the public internet (not a private or local address).";
  return null;
}

function isMetadataHost(host: string): boolean {
  if (host === "metadata.google.internal" || host === "metadata" || host.endsWith(".internal") && host.startsWith("metadata")) return true;
  return isIP(host) ? isMetadataAddress(host) : false;
}

export { isPrivateAddress, isMetadataAddress } from "./net";

export async function addChannel(userId: string, type: ChannelType, target: string, label = ""): Promise<{ ok: true; channel: Channel } | { ok: false; error: string }> {
  const t = target.trim();
  if (type === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t)) return { ok: false, error: "Enter a valid email address." };
  if (type === "webhook") { const problem = await webhookProblem(t); if (problem) return { ok: false, error: problem }; }
  const count = await db.select({ c: sql<number>`count(*)::int` }).from(schema.notificationChannels).where(eq(schema.notificationChannels.userId, userId));
  if (Number(count[0]?.c ?? 0) >= 20) return { ok: false, error: "You already have 20 channels; remove one first." };
  const row = { id: randomUUID(), userId, type, target: t, label: label.trim().slice(0, 40), enabled: 1, createdAt: new Date() };
  await db.insert(schema.notificationChannels).values(row);
  return { ok: true, channel: { id: row.id, userId, type, target: t, label: row.label } };
}

export async function removeChannel(userId: string, id: string) {
  await db.delete(schema.notificationChannels).where(and(eq(schema.notificationChannels.id, id), eq(schema.notificationChannels.userId, userId)));
}

// Members who may decide requests in a workspace, with their channels.
export async function deciderUserIds(workspaceId: string): Promise<string[]> {
  const members = await db.select({ userId: schema.member.userId, role: schema.member.role }).from(schema.member).where(eq(schema.member.organizationId, workspaceId));
  return members.filter((m) => /\b(owner|admin|approver)\b/.test(m.role)).map((m) => m.userId);
}

// Who should hear about a request: the members of its approval route, if it
// matched one (and they still may decide); otherwise every decider.
export async function notifyUserIds(workspaceId: string, routeId?: string | null): Promise<string[]> {
  const deciders = await deciderUserIds(workspaceId);
  if (!routeId) return deciders;
  const [route] = await db.select({ userIds: schema.approvalRoutes.userIds }).from(schema.approvalRoutes).where(eq(schema.approvalRoutes.id, routeId)).limit(1);
  if (!route) return deciders;
  const wanted = new Set(parseUserIds(route.userIds));
  const routed = deciders.filter((u) => wanted.has(u));
  return routed.length ? routed : deciders;
}

export async function recipientsFor(workspaceId: string, routeId?: string | null): Promise<Channel[]> {
  const users = await notifyUserIds(workspaceId, routeId);
  if (users.length === 0) return [];
  const rows = await db.select().from(schema.notificationChannels).where(and(inArray(schema.notificationChannels.userId, users), eq(schema.notificationChannels.enabled, 1)));
  return rows.map((r) => ({ id: r.id, userId: r.userId, type: r.type as ChannelType, target: r.target, label: r.label }));
}

function fallbackChannels(): Channel[] {
  const out: Channel[] = [];
  if (process.env.NOTIFY_WEBHOOK_URL) out.push({ id: "env-webhook", userId: "", type: "webhook", target: process.env.NOTIFY_WEBHOOK_URL, label: "deployment" });
  return out;
}

export function deploymentChannels(): ChannelType[] {
  return fallbackChannels().map((c) => c.type);
}

// ---------- Sending ----------

async function withTimeout<T>(p: Promise<T>, ms = 4000): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("notify timeout")), ms))]);
}
function esc(s: string) { return s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!)); }

export type Outcome = { channel: ChannelType; target: string; ok: boolean; error?: string };

export type Message = { title: string; html: string; text: string; payload: Record<string, unknown>; links: Links | null; linksFor?: (userId: string) => Links | null };

export async function deliver(channels: Channel[], msg: Message): Promise<Outcome[]> {
  return Promise.all(channels.map(async (c): Promise<Outcome> => {
    try {
      // Each recipient gets links signed for them.
      const links = c.userId && msg.linksFor ? msg.linksFor(c.userId) : msg.links;
      const payload = "links" in msg.payload ? { ...msg.payload, links } : msg.payload;
      if (c.type === "webhook") {
        if (c.id !== "env-webhook") { const problem = await webhookProblem(c.target); if (problem) throw new Error(problem); }
        await safeFetch(c.target, { method: "POST", headers: { "content-type": "application/json", "user-agent": "Mandate-Webhook/1" }, body: JSON.stringify(payload) }, { timeoutMs: 4000, allowPrivate: c.id === "env-webhook" || privateWebhooksAllowed() }).then((r) => { if (!r.ok) throw new Error(`webhook ${r.status}`); });
      }
      else if (c.type === "email") await withTimeout(sendEmail(c.target, msg.title, msg.text, msg.html, links), 8000);
      return { channel: c.type, target: mask(c.target), ok: true };
    } catch (e) {
      return { channel: c.type, target: mask(c.target), ok: false, error: (e as Error).message };
    }
  }));
}

function mask(t: string) { return t.length > 8 ? t.slice(0, 3) + "…" + t.slice(-3) : t; }

async function sendEmail(to: string, subject: string, text: string, html: string, links: Links | null) {
  const buttons = links ? `<p><a href="${links.approve}" style="background:#2F7A4C;color:#fff;padding:8px 14px;border-radius:3px;text-decoration:none">Approve once</a> &nbsp; <a href="${links.deny}" style="background:#9E2F2F;color:#fff;padding:8px 14px;border-radius:3px;text-decoration:none">Deny</a> &nbsp; <a href="${links.inbox}">Open inbox</a></p>` : "";
  await sendMail({ to, subject, text: text + (links ? `\n\nApprove: ${links.approve}\nDeny: ${links.deny}` : ""), html: `<p>${html.replace(/\n/g, "<br>")}</p>${buttons}` }, text + (links ? `\n${links.approve}\n${links.deny}` : ""));
}

// ---------- Messages ----------

export type ApprovalNotice = { approval: Approval; mandate: Mandate; agentName: string };

export function approvalMessage(n: ApprovalNotice): Message {
  const links = decisionLinks(n.approval.id);
  const linksFor = (userId: string) => decisionLinks(n.approval.id, userId);
  const amount = fmt(n.approval.amount, n.approval.currency);
  const flags = parseFlags(n.approval.flags);
  const veto = n.approval.kind === "veto" && n.approval.vetoUntil ? new Date(n.approval.vetoUntil) : null;
  const cosign = n.approval.requiredApprovers > 1 ? n.approval.requiredApprovers : 0;
  const sandbox = n.mandate.sandbox === 1 ? "[sandbox] " : "";
  const html = `${sandbox ? "<b>[sandbox]</b> " : ""}<b>${esc(n.agentName)}</b> ${veto ? "will spend" : "wants to spend"} <b>${esc(amount)}</b> at <b>${esc(n.approval.merchant)}</b>` +
    (cosign ? `\n<b>${cosign} approvers</b> must co-sign this one; yours is one signature.` : "") +
    (veto ? ` at <b>${veto.toISOString().slice(11, 16)} UTC</b> unless you cancel` : "") +
    (n.approval.purpose ? `\n“${esc(n.approval.purpose)}”` : "") +
    (flags.length ? `\n⚑ ${esc(flags.map((f) => `${FLAG_LABELS[f].label}: ${FLAG_LABELS[f].hint}`).join(" · "))}` : "") +
    `\nMandate: ${esc(n.mandate.name)} · ${veto ? `above your ${esc(fmt(n.mandate.vetoAbove ?? 0, n.mandate.currency))} veto threshold — no action means yes` : `above your ${esc(fmt(n.mandate.approvalAbove ?? 0, n.mandate.currency))} threshold`}` +
    (links ? "" : `\nOpen the inbox to decide: ${baseUrl()}/approvals`);
  const text = html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return {
    title: sandbox + (veto ? `${n.agentName} will spend ${amount} at ${n.approval.merchant} in ${n.mandate.vetoMinutes} min unless you cancel` : cosign ? `${n.agentName} asks to spend ${amount} at ${n.approval.merchant} — ${cosign} approvers needed` : `${n.agentName} asks to spend ${amount} at ${n.approval.merchant}`),
    html, text, links, linksFor,
    payload: {
      event: "approval.requested", kind: n.approval.kind, approvalId: n.approval.id, mandateId: n.mandate.id, mandateName: n.mandate.name, agentName: n.agentName,
      amount: n.approval.amount, currency: n.approval.currency, amountDisplay: amount, merchant: n.approval.merchant, purpose: n.approval.purpose, flags,
      requestedAt: new Date(n.approval.requestedAt).toISOString(), vetoUntil: veto ? veto.toISOString() : null, requiredApprovers: n.approval.requiredApprovers, sandbox: n.mandate.sandbox === 1, routeId: n.approval.routeId, links,
    },
  };
}

// ---------- Plans ----------

export function planLinks(planId: string, userId?: string | null): Links | null {
  const exp = Date.now() + LINK_TTL_MS;
  const a = signLink("plan:" + planId, "approve", exp, userId);
  const d = signLink("plan:" + planId, "deny", exp, userId);
  if (!a || !d) return null;
  return { approve: `${baseUrl()}/p/${planId}?d=approve&t=${a}`, deny: `${baseUrl()}/p/${planId}?d=deny&t=${d}`, inbox: `${baseUrl()}/approvals` };
}
export function verifyPlanLink(planId: string, decision: "approve" | "deny", token: string): boolean { return parseLink("plan:" + planId, decision, token).ok; }
export function parsePlanLink(planId: string, decision: "approve" | "deny", token: string): LinkCheck { return parseLink("plan:" + planId, decision, token); }

export async function sendPlanProposed(plan: Plan): Promise<Outcome[]> {
  const [m] = await db.select({ name: schema.mandates.name, agentId: schema.mandates.agentId, workspaceId: schema.mandates.workspaceId }).from(schema.mandates).where(eq(schema.mandates.id, plan.mandateId)).limit(1);
  if (!m) return [];
  const [ag] = await db.select({ name: schema.agents.name }).from(schema.agents).where(eq(schema.agents.id, m.agentId)).limit(1);
  const agentName = ag?.name ?? "An agent";
  let channels = await recipientsFor(m.workspaceId);
  if (channels.length === 0) channels = fallbackChannels();
  const items = parsePlanItems(plan.items);
  const links = planLinks(plan.id);
  const total = fmt(plan.totalMax, plan.currency);
  const html = `<b>${esc(agentName)}</b> proposes a plan: <b>${esc(plan.title)}</b> — ${items.length} item${items.length === 1 ? "" : "s"}, up to <b>${esc(total)}</b>\n` +
    items.map((it) => `• ${esc(fmt(it.amount, plan.currency))} at ${esc(it.merchant)}${it.purpose ? ` — ${esc(it.purpose)}` : ""}`).join("\n") +
    `\nMandate: ${esc(m.name)}. Approve the plan once and each purchase inside it goes through without asking; anything outside it still asks.`;
  const text = html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const msg: Message = { title: `${agentName} proposes a plan: ${plan.title} (${items.length} items, up to ${total})`, html, text, links, linksFor: (uid) => planLinks(plan.id, uid), payload: { event: "plan.proposed", planId: plan.id, mandateId: plan.mandateId, mandateName: m.name, agentName, title: plan.title, totalMax: plan.totalMax, currency: plan.currency, items, links } };
  const out = channels.length ? await deliver(channels, msg) : [];
  try {
    const { pushEnabled, sendPush } = await import("./push");
    if (pushEnabled()) {
      let devices = 0, sent = 0;
      for (const uid of await deciderUserIds(m.workspaceId)) { const l = planLinks(plan.id, uid); const r = await sendPush([uid], { title: msg.title, body: items.slice(0, 3).map((it) => `${fmt(it.amount, plan.currency)} at ${it.merchant}`).join(" · "), tag: `plan:${plan.id}`, inboxUrl: `${baseUrl()}/approvals`, approveUrl: l?.approve, denyUrl: l?.deny }); devices += r.devices; sent += r.sent; }
      if (devices) out.push({ channel: "push", target: `${devices} devices`, ok: sent > 0 });
    }
  } catch { /* push is optional */ }
  return out;
}

export async function sendApprovalRequested(n: ApprovalNotice): Promise<Outcome[]> {
  let channels = await recipientsFor(n.mandate.workspaceId, n.approval.routeId);
  if (channels.length === 0) channels = fallbackChannels();
  const msg = approvalMessage(n);
  const [outcomes, push] = await Promise.all([channels.length ? deliver(channels, msg) : Promise.resolve([] as Outcome[]), pushApproval(n, msg)]);
  return push ? [...outcomes, push] : outcomes;
}

// Phones and browsers that turned push on get the request with Approve /
// Deny buttons; the buttons call the signed one-tap endpoint directly.
async function pushApproval(n: ApprovalNotice, msg: Message): Promise<Outcome | null> {
  const { pushEnabled, sendPush } = await import("./push");
  if (!pushEnabled()) return null;
  try {
    let devices = 0, sent = 0;
    for (const uid of await notifyUserIds(n.mandate.workspaceId, n.approval.routeId)) {
      const l = msg.linksFor ? msg.linksFor(uid) : msg.links;
      const r = await sendPush([uid], { title: msg.title, body: `${n.mandate.name}${n.approval.purpose ? ` — “${n.approval.purpose}”` : ""}`, tag: `approval:${n.approval.id}`, inboxUrl: `${baseUrl()}/approvals`, approveUrl: l?.approve, denyUrl: l?.deny });
      devices += r.devices; sent += r.sent;
    }
    if (devices === 0) return null;
    return { channel: "push", target: `${devices} device${devices === 1 ? "" : "s"}`, ok: sent > 0, error: sent === 0 ? "no device accepted the push" : undefined };
  } catch (e) { return { channel: "push", target: "devices", ok: false, error: (e as Error).message }; }
}

export async function sendWarning(workspaceId: string, title: string, body: string, payload: Record<string, unknown>): Promise<Outcome[]> {
  let channels = await recipientsFor(workspaceId);
  if (channels.length === 0) channels = fallbackChannels();
  if (channels.length === 0) return [];
  return deliver(channels, { title, html: `<b>${esc(title)}</b>\n${esc(body)}`, text: `${title}\n${body}`, payload: { event: "warning", ...payload }, links: null });
}

export async function sendTest(channels: Channel[]): Promise<Outcome[]> {
  return deliver(channels, { title: "Mandate is connected", html: "<b>Mandate</b> is connected. Approval requests from your agents will arrive here with Approve / Deny links.", text: "Mandate is connected. Approval requests from your agents will arrive here.", payload: { event: "test", message: "Mandate is connected." }, links: null });
}
