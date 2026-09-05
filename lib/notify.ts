import { createHmac, timingSafeEqual } from "node:crypto";
import { fmt } from "./policy";
import type { Approval, Mandate } from "./schema";

// Notifications are fire-and-forget: they never delay or change a decision.
// Channels are configured by environment variables:
//   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID   -> Telegram message with Approve / Deny buttons
//   NOTIFY_WEBHOOK_URL                      -> POST JSON to any URL (Slack, n8n, Zapier, your own)
// One-tap links are signed with NOTIFY_SECRET (falls back to ADMIN_PASSWORD) and
// expire with the approval, so a forwarded message cannot approve anything later.

export const LINK_TTL_MS = 24 * 3600 * 1000;

export function notifySecret(): string | null {
  return process.env.NOTIFY_SECRET ?? process.env.ADMIN_PASSWORD ?? null;
}

export function baseUrl(): string {
  return (process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

export function signLink(approvalId: string, decision: "approve" | "deny", expMs: number): string | null {
  const secret = notifySecret();
  if (!secret) return null;
  const sig = createHmac("sha256", secret).update(`${approvalId}|${decision}|${expMs}`).digest("base64url");
  return `${expMs}.${sig}`;
}

export function verifyLink(approvalId: string, decision: "approve" | "deny", token: string): boolean {
  const secret = notifySecret();
  if (!secret) return false;
  const [expStr, sig] = token.split(".");
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp || !sig) return false;
  const expected = createHmac("sha256", secret).update(`${approvalId}|${decision}|${exp}`).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function decisionLinks(approvalId: string) {
  const exp = Date.now() + LINK_TTL_MS;
  const a = signLink(approvalId, "approve", exp);
  const d = signLink(approvalId, "deny", exp);
  if (!a || !d) return null;
  return {
    approve: `${baseUrl()}/a/${approvalId}?d=approve&t=${a}`,
    deny: `${baseUrl()}/a/${approvalId}?d=deny&t=${d}`,
    inbox: `${baseUrl()}/approvals`,
  };
}

export type Channel = "telegram" | "webhook";

export function configuredChannels(): Channel[] {
  const out: Channel[] = [];
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) out.push("telegram");
  if (process.env.NOTIFY_WEBHOOK_URL) out.push("webhook");
  return out;
}

async function withTimeout<T>(p: Promise<T>, ms = 4000): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("notify timeout")), ms))]);
}

function esc(s: string) { return s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!)); }

export type ApprovalNotice = { approval: Approval; mandate: Mandate; agentName: string };

export async function sendApprovalRequested(n: ApprovalNotice): Promise<{ channel: Channel; ok: boolean; error?: string }[]> {
  const channels = configuredChannels();
  if (channels.length === 0) return [];
  const links = decisionLinks(n.approval.id);
  const amount = fmt(n.approval.amount, n.approval.currency);
  const text = `<b>${esc(n.agentName)}</b> wants to spend <b>${esc(amount)}</b> at <b>${esc(n.approval.merchant)}</b>` +
    (n.approval.purpose ? `\n“${esc(n.approval.purpose)}”` : "") +
    `\nMandate: ${esc(n.mandate.name)} · above your ${esc(fmt(n.mandate.approvalAbove ?? 0, n.mandate.currency))} threshold` +
    (links ? "" : `\nOpen the inbox to decide: ${baseUrl()}/approvals`);
  const payload = {
    event: "approval.requested",
    approvalId: n.approval.id, mandateId: n.mandate.id, mandateName: n.mandate.name, agentName: n.agentName,
    amount: n.approval.amount, currency: n.approval.currency, amountDisplay: amount,
    merchant: n.approval.merchant, purpose: n.approval.purpose, requestedAt: new Date(n.approval.requestedAt).toISOString(),
    links,
  };
  const results = await Promise.all(channels.map(async (channel) => {
    try {
      if (channel === "telegram") await withTimeout(sendTelegram(text, links));
      else await withTimeout(fetch(process.env.NOTIFY_WEBHOOK_URL!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).then((r) => { if (!r.ok) throw new Error(`webhook ${r.status}`); }));
      return { channel, ok: true };
    } catch (e) {
      return { channel, ok: false, error: (e as Error).message };
    }
  }));
  return results;
}

async function sendTelegram(html: string, links: ReturnType<typeof decisionLinks>) {
  const token = process.env.TELEGRAM_BOT_TOKEN!;
  const chat = process.env.TELEGRAM_CHAT_ID!;
  const body: Record<string, unknown> = { chat_id: chat, text: html, parse_mode: "HTML", disable_web_page_preview: true };
  if (links) {
    body.reply_markup = { inline_keyboard: [[{ text: "Approve once", url: links.approve }, { text: "Deny", url: links.deny }], [{ text: "Open inbox", url: links.inbox }]] };
  }
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`telegram ${r.status}: ${(await r.text()).slice(0, 120)}`);
}

export async function sendTest(): Promise<{ channel: Channel; ok: boolean; error?: string }[]> {
  const channels = configuredChannels();
  return Promise.all(channels.map(async (channel) => {
    try {
      if (channel === "telegram") await withTimeout(sendTelegram("<b>Mandate</b> is connected. Approval requests from your agents will arrive here with Approve / Deny buttons.", null));
      else await withTimeout(fetch(process.env.NOTIFY_WEBHOOK_URL!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "test", message: "Mandate is connected." }) }).then((r) => { if (!r.ok) throw new Error(`webhook ${r.status}`); }));
      return { channel, ok: true };
    } catch (e) {
      return { channel, ok: false, error: (e as Error).message };
    }
  }));
}
