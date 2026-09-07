import { requireCtx } from "@/lib/session";
import { deploymentChannels, notifySecret, baseUrl, listChannels } from "@/lib/notify";
import { stripeEnabled } from "@/lib/stripe";
import { PENDING_TTL_MS } from "@/lib/service";
import { listConnectedAgents } from "@/lib/connections";
import { sendTestNotificationAction, revokeOAuthClientAction, addChannelAction, removeChannelAction, saveCardholderProfileAction, leaveWorkspaceAction, deleteWorkspaceAction, deleteAccountAction, revokeSessionAction, revokeOtherSessionsAction } from "@/app/actions";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { soleOwnedWorkspaces } from "@/lib/service";
import { getCardholderProfile } from "@/lib/service";
import { cardholderProblem, issuingRegion, termsAcceptanceRequired } from "@/lib/stripe";
import { When } from "@/app/components";
import { PasskeyPanel } from "./passkeys";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ test?: string; disconnected?: string; channel?: string; error?: string; cardholder?: string; sessions?: string }> }) {
  const ctx = await requireCtx();
  const { test, disconnected, channel, error, cardholder, sessions: sessionsMsg } = await searchParams;
  const region = issuingRegion();
  const h = await headers();
  const [connected, channels, profile, sessions, current, sole] = await Promise.all([
    listConnectedAgents(ctx.userId), listChannels(ctx.userId), getCardholderProfile(ctx.workspaceId),
    auth.api.listSessions({ headers: h }).catch(() => []), auth.api.getSession({ headers: h }), soleOwnedWorkspaces(ctx.userId),
  ]);
  const emailOn = Boolean(process.env.RESEND_API_KEY);
  const rows: [string, boolean, string][] = [
    ["Google sign-in", Boolean(process.env.GOOGLE_CLIENT_ID), "GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET"],
    ["Email delivery (sign-in links, alerts, invitations)", emailOn, "RESEND_API_KEY + EMAIL_FROM (else printed to the server console)"],
    ["Deployment-wide fallback webhook", deploymentChannels().length > 0, "NOTIFY_WEBHOOK_URL (used only when no member has a channel)"],
    ["One-tap links signed", Boolean(notifySecret()), "NOTIFY_SECRET"],
    ["Stripe virtual cards + top-ups", stripeEnabled(), "STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET + STRIPE_PUBLISHABLE_KEY"],
  ];
  return (
    <div style={{ maxWidth: 780 }}>
      <div className="eyebrow">Settings</div>
      <h1>Your account, your agents, how Mandate reaches you</h1>
      <p className="muted" style={{ margin: "8px 0 20px" }}>Signed in as <strong>{ctx.email}</strong> · {ctx.role} of <strong>{ctx.workspaceName}</strong></p>

      <h2 style={{ marginBottom: 8 }}>How to reach you</h2>
      <p className="muted">Requests that need a decision go to every approver in the workspace by email or webhook, according to the channels each person sets here. Yours apply in all your workspaces.</p>
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
            <select id="type" name="type" defaultValue="email">
              <option value="email">Email{emailOn ? "" : " (prints to console until RESEND_API_KEY is set)"}</option>
              <option value="webhook">Webhook (n8n, Zapier, Make, your own URL)</option>
            </select>
          </div>
          <div className="field"><label htmlFor="target">Email address or webhook URL</label><input id="target" name="target" required placeholder={ctx.email} /></div>
          <div className="field"><label htmlFor="label">Label (optional)</label><input id="label" name="label" placeholder="personal, ops automation…" /></div>
          <div className="actions"><button className="btn accent" type="submit">Add</button></div>
        </form>
        <div className="card">
          <div className="eyebrow" style={{ marginBottom: 6 }}>What a webhook receives</div>
          <p className="muted" style={{ fontSize: 13.5 }}>A JSON POST for each event: <code>approval.requested</code> with the agent, mandate, amount, merchant, purpose and signed <code>links.approve</code> / <code>links.deny</code> / <code>links.inbox</code>; <code>warning</code> for utilisation and velocity alerts; <code>test</code> from the button above. Point it at an n8n, Zapier or Make trigger, or your own endpoint, and route it wherever you already look.</p>
        </div>
      </div>

      <h2 style={{ marginBottom: 8 }}>Connected agents</h2>
      <p className="muted">Agents that connected through OAuth (Claude, ChatGPT, Cursor, or anything speaking MCP). Disconnecting revokes their tokens immediately; revoking a mandate cuts them off from that mandate regardless.</p>
      {disconnected && <div className="notice ok" style={{ marginBottom: 12 }}>Disconnected.</div>}
      <div className="tbl" style={{ marginBottom: 28 }}>
        <table>
          <thead><tr><th>Agent</th><th>Allowed to</th><th>Workspace</th><th>Connected</th><th></th></tr></thead>
          <tbody>
            {connected.length === 0 && <tr><td colSpan={5} className="empty">Nothing connected yet. See <a href="/docs">Connect agents</a>.</td></tr>}
            {connected.map((c) => (
              <tr key={c.clientId}>
                <td>{c.name}{c.uri && <div className="faint mono" style={{ fontSize: 11.5 }}>{c.uri}</div>}</td>
                <td className="mono" style={{ fontSize: 12.5 }}>{c.scopes.join(" ")}</td>
                <td>{c.workspaceId === ctx.workspaceId ? "this workspace" : c.workspaceId ? <span className="faint">another workspace</span> : <span className="pill bad" title="Connected before workspace binding existed; disconnect and connect again.">not bound</span>}</td>
                <td><When d={c.grantedAt} /></td>
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
      <p className="muted">Stripe Issuing needs the real name, date of birth, mobile number and billing address of the person the cards belong to. Saved per workspace; used when a mandate is issued with a card. This deployment issues <strong>{region.currency}</strong> cards to addresses in <strong>{region.code === "EU" ? "the EEA" : region.code}</strong>.</p>
      {cardholder && <div className="notice ok" style={{ marginBottom: 12 }}>Cardholder details saved.</div>}
      {profile && cardholderProblem(profile) && <div className="notice" style={{ marginBottom: 12 }}>Not ready for cards yet: {cardholderProblem(profile)}</div>}
      {profile?.cardholderStatus && profile.cardholderStatus !== "active" && <div className="notice bad" style={{ marginBottom: 12 }}>Stripe has this cardholder as <strong>{profile.cardholderStatus}</strong>{JSON.parse(profile.cardholderRequirements || "[]").length ? <>; it still needs: {JSON.parse(profile.cardholderRequirements).join(", ")}</> : ""}. Cards will decline until that is resolved.</div>}
      {(ctx.role === "owner" || ctx.role === "admin") ? (
        <form action={saveCardholderProfileAction} className="card form" style={{ marginBottom: 8 }}>
          <div className="row">
            <div className="field"><label htmlFor="ch-name">Full name</label><input id="ch-name" name="name" required defaultValue={profile?.name ?? ctx.name} /></div>
            <div className="field"><label htmlFor="ch-email">Email</label><input id="ch-email" name="email" type="email" defaultValue={profile?.email ?? ctx.email} /></div>
          </div>
          <div className="row">
            <div className="field"><label htmlFor="ch-phone">Mobile (E.164)</label><input id="ch-phone" name="phone" required defaultValue={profile?.phone ?? ""} placeholder="+14155550123" /><span className="hint">Used by Stripe for 3-D Secure checks at online checkouts.</span></div>
            <div className="field"><label htmlFor="ch-dob">Date of birth (YYYY-MM-DD)</label><input id="ch-dob" name="dob" required defaultValue={profile?.dob ?? ""} placeholder="1985-04-02" /></div>
          </div>
          <div className="field"><label htmlFor="ch-line1">Address line 1</label><input id="ch-line1" name="line1" required defaultValue={profile?.line1 ?? ""} /></div>
          <div className="field"><label htmlFor="ch-line2">Address line 2</label><input id="ch-line2" name="line2" defaultValue={profile?.line2 ?? ""} /></div>
          <div className="row-3">
            <div className="field"><label htmlFor="ch-city">City</label><input id="ch-city" name="city" required defaultValue={profile?.city ?? ""} /></div>
            <div className="field"><label htmlFor="ch-state">State / region</label><input id="ch-state" name="state" defaultValue={profile?.state ?? ""} /></div>
            <div className="field"><label htmlFor="ch-postal">Postal code</label><input id="ch-postal" name="postalCode" required defaultValue={profile?.postalCode ?? ""} /></div>
          </div>
          <div className="field" style={{ maxWidth: 200 }}><label htmlFor="ch-country">Country (2 letters)</label><input id="ch-country" name="country" required maxLength={2} defaultValue={profile?.country ?? region.countries[0]} /></div>
          {profile?.termsAcceptedAt ? (
            <p className="faint" style={{ fontSize: 12.5, margin: 0 }}>Stripe's cardholder terms accepted on <When d={profile.termsAcceptedAt} />.</p>
          ) : (
            <label className="check"><input type="checkbox" name="acceptTerms" required={termsAcceptanceRequired()} /> I accept the <a href="https://stripe.com/legal/issuing/celtic-authorized-user-terms" target="_blank" rel="noreferrer">Stripe Issuing cardholder terms</a> and the card issuer's terms for my region{termsAcceptanceRequired() ? " (required)" : ""}.</label>
          )}
          <div className="actions"><button className="btn secondary" type="submit">Save cardholder details</button></div>
        </form>
      ) : <p className="faint">Owners and admins set this.</p>}

      <h2 style={{ margin: "28px 0 8px" }}>Where you're signed in</h2>
      <p className="muted">Every active session for your account. Revoke one you don't recognise; it signs that device out immediately.</p>
      {sessionsMsg && <div className="notice ok" style={{ marginBottom: 12 }}>Session(s) revoked.</div>}
      <div className="tbl" style={{ marginBottom: 10 }}>
        <table>
          <thead><tr><th>Device</th><th>Address</th><th>Signed in</th><th>Expires</th><th></th></tr></thead>
          <tbody>
            {(sessions as { id: string; token: string; userAgent?: string | null; ipAddress?: string | null; createdAt: Date; expiresAt: Date }[]).map((s) => {
              const isThis = current?.session.token === s.token;
              return (
                <tr key={s.id}><td style={{ maxWidth: 320, fontSize: 12.5 }}>{(s.userAgent ?? "unknown").slice(0, 90)}{isThis && <span className="pill ok" style={{ marginLeft: 8 }}>this device</span>}</td><td className="mono faint">{s.ipAddress ?? ""}</td><td><When d={s.createdAt} /></td><td><When d={s.expiresAt} /></td>
                  <td>{!isThis && <form action={revokeSessionAction}><input type="hidden" name="id" value={s.id} /><button className="btn secondary sm" type="submit">Revoke</button></form>}</td></tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <form action={revokeOtherSessionsAction} style={{ marginBottom: 28 }}><button className="btn secondary sm" type="submit">Sign out everywhere else</button></form>

      <h2 style={{ margin: "28px 0 8px" }}>Your data</h2>
      <p className="muted">Download everything Mandate holds about you and the workspaces you're in, as JSON.</p>
      <a className="btn secondary" href="/api/account/export" style={{ marginBottom: 28, display: "inline-flex" }}>Export my data</a>

      <h2 style={{ margin: "28px 0 8px", color: "var(--bad)" }}>Danger zone</h2>
      <div className="stack" style={{ marginBottom: 28 }}>
        {ctx.role !== "owner" ? (
          <form action={leaveWorkspaceAction} className="card"><div className="eyebrow" style={{ marginBottom: 6 }}>Leave {ctx.workspaceName}</div><p className="muted">You'll stop receiving its requests and lose access to its ledger.</p><button className="btn danger sm" type="submit">Leave this workspace</button></form>
        ) : (
          <form action={deleteWorkspaceAction} className="card form"><div className="eyebrow">Delete {ctx.workspaceName}</div><p className="muted" style={{ margin: 0 }}>Deletes every agent, mandate, decision and the ledger in this workspace, for every member. Revoke or export first if you need the records. Type the workspace name to confirm.</p>
            <div className="field" style={{ maxWidth: 320 }}><input name="confirm" placeholder={ctx.workspaceName} autoComplete="off" /></div><div><button className="btn danger sm" type="submit">Delete workspace permanently</button></div></form>
        )}
        <form action={deleteAccountAction} className="card form"><div className="eyebrow">Delete my account</div>
          <p className="muted" style={{ margin: 0 }}>Removes your sign-in methods, sessions, connected agents and channels. {sole.length > 0 && <>It also deletes {sole.length === 1 ? "the workspace" : "the workspaces"} where you are the only owner: <strong>{sole.map((w) => w.name).join(", ")}</strong>{sole.some((w) => w.otherMembers > 0) && " — other members will lose access"}. Make someone else an owner first if you want it to survive.</>} Type your email to confirm.</p>
          <div className="field" style={{ maxWidth: 320 }}><input name="confirm" placeholder={ctx.email} autoComplete="off" /></div><div><button className="btn danger sm" type="submit">Delete my account permanently</button></div></form>
      </div>

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
