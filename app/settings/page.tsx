import { configuredChannels, notifySecret, baseUrl } from "@/lib/notify";
import { stripeEnabled } from "@/lib/stripe";
import { protectedMode } from "@/lib/auth";
import { PENDING_TTL_MS } from "@/lib/service";
import { sendTestNotificationAction } from "@/app/actions";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ test?: string }> }) {
  const { test } = await searchParams;
  const channels = configuredChannels();
  const rows: [string, boolean, string][] = [
    ["Dashboard password", protectedMode(), "ADMIN_PASSWORD"],
    ["Telegram alerts", channels.includes("telegram"), "TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID"],
    ["Webhook alerts", channels.includes("webhook"), "NOTIFY_WEBHOOK_URL"],
    ["One-tap links signed", Boolean(notifySecret()), "NOTIFY_SECRET (or ADMIN_PASSWORD)"],
    ["Stripe virtual cards", stripeEnabled(), "STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET"],
  ];
  return (
    <div style={{ maxWidth: 680 }}>
      <div className="eyebrow">Settings</div>
      <h1>How Mandate reaches you</h1>
      <p className="muted" style={{ margin: "8px 0 20px" }}>Configuration lives in environment variables. This page shows what is on, and lets you send a test.</p>
      {test && <div className={`notice ${test === "ok" ? "ok" : "bad"}`} style={{ marginBottom: 16 }}>{test === "ok" ? "Test sent. Check your channel." : test === "none" ? "No channel is configured yet." : `Test failed: ${decodeURIComponent(test)}`}</div>}
      <div className="tbl">
        <table>
          <thead><tr><th>Capability</th><th>State</th><th>Set by</th></tr></thead>
          <tbody>
            {rows.map(([name, on, env]) => (
              <tr key={name}><td>{name}</td><td><span className={`pill ${on ? "ok" : ""}`}>{on ? "on" : "off"}</span></td><td className="mono faint">{env}</td></tr>
            ))}
            <tr><td>Unanswered requests expire after</td><td className="num">{PENDING_TTL_MS / 3600000} h</td><td className="mono faint">APPROVAL_TTL_HOURS</td></tr>
            <tr><td>Public base URL (used in links)</td><td className="mono">{baseUrl()}</td><td className="mono faint">NEXT_PUBLIC_BASE_URL</td></tr>
          </tbody>
        </table>
      </div>
      <form action={sendTestNotificationAction} className="actions" style={{ marginTop: 16 }}>
        <button className="btn secondary" type="submit" disabled={channels.length === 0}>Send a test notification</button>
      </form>
      <h2 style={{ margin: "32px 0 8px" }}>Telegram in two minutes</h2>
      <p className="muted">Message <code>@BotFather</code>, send <code>/newbot</code>, copy the token into <code>TELEGRAM_BOT_TOKEN</code>. Start a chat with your new bot and send it any message, then open <code>https://api.telegram.org/bot&lt;token&gt;/getUpdates</code> and copy <code>chat.id</code> into <code>TELEGRAM_CHAT_ID</code>. Restart the app and send a test above.</p>
    </div>
  );
}
