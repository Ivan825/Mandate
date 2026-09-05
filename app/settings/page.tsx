import { requireCtx } from "@/lib/session";
import { deploymentChannels, notifySecret, baseUrl, listChannels } from "@/lib/notify";
import { stripeEnabled } from "@/lib/stripe";
import { PENDING_TTL_MS } from "@/lib/service";
import { listConnectedAgents } from "@/lib/connections";
import { sendTestNotificationAction, revokeOAuthClientAction, addChannelAction, removeChannelAction, saveCardholderProfileAction } from "@/app/actions";
import { getCardholderProfile } from "@/lib/service";
import { When } from "@/app/components";
import { PasskeyPanel } from "./passkeys";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ test?: string; disconnected?: string; channel?: string; error?: string; cardholder?: string }> }) {
  const ctx = await requireCtx();
  const { test, disconnected, channel, error, cardholder } = await searchParams;
  const [connected, channels, profile] = await Promise.all([listConnectedAgents(ctx.userId), listChannels(ctx.userId), getCardholderProfile(ctx.workspaceId)]);
  const telegramOn = Boolean(process.env.TELEGRAM_BOT_TOKEN);
  const emailOn = Boolean(process.env.RESEND_API_KEY);
  const rows: [string, boolean, string][] = [
    ["Google sign-in", Boolean(process.env.GOOGLE_CLIENT_ID), "GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET"],
    ["Email delivery (sign-in links, alerts, invitations)", emailOn, "RESEND_API_KEY + EMAIL_FROM (else printed to the server console)"],
    ["Telegram bot", telegramOn, "TELEGRAM_BOT_TOKEN"],
    ["Deployment-wide fallback alerts", deploymentChannels().length > 0, "TELEGRAM_CHAT_ID / NOTIFY_WEBHOOK_URL (used only when no member has a channel)"],
    ["One-tap links signed", Boolean(notifySecret()), "NOTIFY_SECRET"],
    ["Stripe virtual cards", stripeEnabled(), "STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET"],
  ];
  return (
    <div style={{ maxWidth: 780 }}>
      <div className="eyebrow">Settings</div>
      <h1>Your account, your agents, how Mandate reaches you</h1>
      <p className="muted" style={{ margin: "8px 0 20px" }}>Signed in as <strong>{ctx.email}</strong> · {ctx.role} of <strong>{ctx.workspaceName}</strong></p>

      <h2 style={{ marginBottom: 8 }}>How to reach you</h2>
      <p className="muted">Requests that need a decision go to every approver in the workspace through the channels each person sets here. Yours apply in all your workspaces.</p>
      {channel === "added" && <div className="notice ok" style={{ marginBottom: 12 }}>Channel added. Send a test to confirm it works.</div>}
      {error && <div className="notice bad" style={{ marginBottom: 12 }}>{error}</div>}
      {test && <div className={`notice ${test === "ok" ? "ok" : "bad"}`} style={{ marginBottom: 12 }}>{test === "ok" ? "Test sent. Check your channels." : test === "none" ? "Add a channel first." : `Test failed: ${decodeURIComponent(test)}`}</div>}
      <div className="tbl" style={{ marginBottom: 12 }}>
        <table>
          <thead><tr><th>Channel</th><th>Target</th><th>Label</th><th></th></tr></thead>
          <tbody>
            {channels.length === 0 && <tr><td colSpan={4} className="empty">No channels yet — you'll only see requests when you open the inbox.</td></tr>}
            {channels.map((c) => (
              <tr key={c.id}><td className="mono">{c.type}</td><td className="mono" style={{ fontSize: 12.5 }}>{c.target}</td><td>{c.label}</td><td><form action={removeChannelAction}><input type="hidden" name="id" value={c.id} /><button className="btn secondary sm" type="submit">Remove</button></form></td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <form action={sendTestNotificationAction} style={{ marginBottom: 14 }}><button className="btn secondary sm" type="submit" disabled={channels.length === 0}>Send a test to all my channels</button></form>
      <div className="grid-2" style={{ marginBottom: 28 }}>
        <form action={addChannelAction} className="card form">
          <div className="eyebrow">Add a channel</div>
          <div className="field"><label htmlFor="type">Type</label>
            <select id="type" name="type" defaultValue={emailOn ? "email" : telegramOn ? "telegram" : "webhook"}>
              <option value="email">Email{emailOn ? "" : " (prints to console until RESEND_API_KEY is set)"}</option>
              <option value="telegram" disabled={!telegramOn}>Telegram{telegramOn ? "" : " (no bot configured)"}</option>
              <option value="webhook">Webhook (Slack, n8n, Zapier, your own URL)</option>
            </select>
          </div>
          <div className="field"><label htmlFor="target">Address, chat id, or URL</label><input id="target" name="target" required placeholder={ctx.email} /></div>
          <div className="field"><label htmlFor="label">Label (optional)</label><input id="label" name="label" placeholder="phone, work Slack…" /></div>
          <div className="actions"><button className="btn accent" type="submit">Add</button></div>
        </form>
        <div className="card">
          <div className="eyebrow" style={{ marginBottom: 6 }}>Telegram in two minutes</div>
          <p className="muted" style={{ fontSize: 13.5 }}>Open Telegram, start a chat with this deployment's bot and send it any message. Then open <code>https://api.telegram.org/bot&lt;token&gt;/getUpdates</code> (the deployment owner has the token) and copy <code>chat.id</code> here. Group chats work too: add the bot to the group and use the group's id.</p>
        </div>
      </div>

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

      <h2 style={{ margin: "28px 0 8px" }}>Cardholder details (for virtual cards)</h2>
      <p className="muted">Stripe Issuing needs a real name and billing address on the card. Saved per workspace; used when a mandate is issued with a card.</p>
      {cardholder && <div className="notice ok" style={{ marginBottom: 12 }}>Cardholder details saved.</div>}
      {(ctx.role === "owner" || ctx.role === "admin") ? (
        <form action={saveCardholderProfileAction} className="card form" style={{ marginBottom: 8 }}>
          <div className="row">
            <div className="field"><label htmlFor="ch-name">Full name</label><input id="ch-name" name="name" required defaultValue={profile?.name ?? ctx.name} /></div>
            <div className="field"><label htmlFor="ch-email">Email</label><input id="ch-email" name="email" type="email" defaultValue={profile?.email ?? ctx.email} /></div>
          </div>
          <div className="row">
            <div className="field"><label htmlFor="ch-phone">Phone (E.164, optional)</label><input id="ch-phone" name="phone" defaultValue={profile?.phone ?? ""} placeholder="+14155550123" /></div>
            <div className="field"><label htmlFor="ch-dob">Date of birth (YYYY-MM-DD, optional)</label><input id="ch-dob" name="dob" defaultValue={profile?.dob ?? ""} placeholder="1985-04-02" /></div>
          </div>
          <div className="field"><label htmlFor="ch-line1">Address line 1</label><input id="ch-line1" name="line1" required defaultValue={profile?.line1 ?? ""} /></div>
          <div className="field"><label htmlFor="ch-line2">Address line 2</label><input id="ch-line2" name="line2" defaultValue={profile?.line2 ?? ""} /></div>
          <div className="row-3">
            <div className="field"><label htmlFor="ch-city">City</label><input id="ch-city" name="city" required defaultValue={profile?.city ?? ""} /></div>
            <div className="field"><label htmlFor="ch-state">State / region</label><input id="ch-state" name="state" defaultValue={profile?.state ?? ""} /></div>
            <div className="field"><label htmlFor="ch-postal">Postal code</label><input id="ch-postal" name="postalCode" required defaultValue={profile?.postalCode ?? ""} /></div>
          </div>
          <div className="field" style={{ maxWidth: 200 }}><label htmlFor="ch-country">Country (2 letters)</label><input id="ch-country" name="country" required maxLength={2} defaultValue={profile?.country ?? "US"} /></div>
          <div className="actions"><button className="btn secondary" type="submit">Save cardholder details</button></div>
        </form>
      ) : <p className="faint">Owners and admins set this.</p>}

      <h2 style={{ margin: "28px 0 8px" }}>This deployment</h2>
      <div className="tbl">
        <table>
          <thead><tr><th>Capability</th><th>State</th><th>Set by</th></tr></thead>
          <tbody>
            {rows.map(([name, on, env]) => (
              <tr key={name}><td>{name}</td><td><span className={`pill ${on ? "ok" : ""}`}>{on ? "on" : "off"}</span></td><td className="mono faint">{env}</td></tr>
            ))}
            <tr><td>Unanswered requests expire after</td><td className="num">{PENDING_TTL_MS / 3600000} h</td><td className="mono faint">APPROVAL_TTL_HOURS</td></tr>
            <tr><td>Public base URL (links, OAuth, MCP)</td><td className="mono">{baseUrl()}</td><td className="mono faint">APP_URL</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
