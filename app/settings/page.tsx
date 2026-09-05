import { requireCtx } from "@/lib/session";
import { configuredChannels, notifySecret, baseUrl } from "@/lib/notify";
import { stripeEnabled } from "@/lib/stripe";
import { PENDING_TTL_MS } from "@/lib/service";
import { listConnectedAgents } from "@/lib/connections";
import { sendTestNotificationAction, revokeOAuthClientAction } from "@/app/actions";
import { When } from "@/app/components";
import { PasskeyPanel } from "./passkeys";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ test?: string; disconnected?: string }> }) {
  const ctx = await requireCtx();
  const { test, disconnected } = await searchParams;
  const channels = configuredChannels();
  const connected = await listConnectedAgents(ctx.userId);
  const rows: [string, boolean, string][] = [
    ["Google sign-in", Boolean(process.env.GOOGLE_CLIENT_ID), "GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET"],
    ["Email sign-in links", Boolean(process.env.RESEND_API_KEY), "RESEND_API_KEY + EMAIL_FROM (else links print to the server console)"],
    ["Telegram alerts", channels.includes("telegram"), "TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID"],
    ["Webhook alerts", channels.includes("webhook"), "NOTIFY_WEBHOOK_URL"],
    ["One-tap links signed", Boolean(notifySecret()), "NOTIFY_SECRET"],
    ["Stripe virtual cards", stripeEnabled(), "STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET"],
  ];
  return (
    <div style={{ maxWidth: 760 }}>
      <div className="eyebrow">Settings</div>
      <h1>Your account, your agents, how Mandate reaches you</h1>
      <p className="muted" style={{ margin: "8px 0 20px" }}>Signed in as <strong>{ctx.email}</strong>. Workspace <span className="mono">{ctx.workspaceId.slice(0, 8)}…</span></p>

      <h2 style={{ marginBottom: 8 }}>Connected agents</h2>
      <p className="muted">Agents that connected through OAuth (Claude, ChatGPT, Cursor, or anything speaking MCP). Disconnecting revokes their tokens immediately; revoking a mandate cuts them off from that mandate regardless.</p>
      {disconnected && <div className="notice ok" style={{ marginBottom: 12 }}>Disconnected.</div>}
      <div className="tbl" style={{ marginBottom: 28 }}>
        <table>
          <thead><tr><th>Agent</th><th>Allowed to</th><th>Connected</th><th>Tokens</th><th></th></tr></thead>
          <tbody>
            {connected.length === 0 && <tr><td colSpan={5} className="empty">Nothing connected yet. See <a href="/docs">Connect agents</a>.</td></tr>}
            {connected.map((c) => (
              <tr key={c.clientId}>
                <td>{c.name}{c.uri && <div className="faint mono" style={{ fontSize: 11.5 }}>{c.uri}</div>}</td>
                <td className="mono" style={{ fontSize: 12.5 }}>{c.scopes.join(" ")}</td>
                <td><When d={c.grantedAt} /></td>
                <td className="num">{c.activeTokens}</td>
                <td><form action={revokeOAuthClientAction}><input type="hidden" name="clientId" value={c.clientId} /><button className="btn danger sm" type="submit">Disconnect</button></form></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 style={{ marginBottom: 8 }}>Passkeys</h2>
      <p className="muted">Sign in with Face ID, Touch ID or a security key instead of waiting for an email link.</p>
      <PasskeyPanel />

      <h2 style={{ margin: "28px 0 8px" }}>Notifications and integrations</h2>
      {test && <div className={`notice ${test === "ok" ? "ok" : "bad"}`} style={{ marginBottom: 12 }}>{test === "ok" ? "Test sent. Check your channel." : test === "none" ? "No channel is configured yet." : `Test failed: ${decodeURIComponent(test)}`}</div>}
      <div className="tbl">
        <table>
          <thead><tr><th>Capability</th><th>State</th><th>Set by</th></tr></thead>
          <tbody>
            {rows.map(([name, on, env]) => (
              <tr key={name}><td>{name}</td><td><span className={`pill ${on ? "ok" : ""}`}>{on ? "on" : "off"}</span></td><td className="mono faint">{env}</td></tr>
            ))}
            <tr><td>Unanswered requests expire after</td><td className="num">{PENDING_TTL_MS / 3600000} h</td><td className="mono faint">APPROVAL_TTL_HOURS</td></tr>
            <tr><td>Public base URL (links, OAuth, MCP)</td><td className="mono">{baseUrl()}</td><td className="mono faint">NEXT_PUBLIC_BASE_URL</td></tr>
          </tbody>
        </table>
      </div>
      <form action={sendTestNotificationAction} className="actions" style={{ marginTop: 12 }}>
        <button className="btn secondary" type="submit" disabled={channels.length === 0}>Send a test notification</button>
      </form>
      <p className="faint" style={{ fontSize: 12.5, marginTop: 18 }}>Notification channels are per deployment today (environment variables); per-user channels are next on the roadmap.</p>
    </div>
  );
}
