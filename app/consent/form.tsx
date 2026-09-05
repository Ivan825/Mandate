"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";

const SCOPE_TEXT: Record<string, string> = {
  "mandate:read": "See your mandates and what is left on each",
  "mandate:spend": "Ask to spend under a mandate (subject to its limits and your approvals)",
  openid: "Know who you are (your user id)",
  profile: "See your name",
  email: "See your email address",
  offline_access: "Stay connected without asking you to sign in again",
};

export function ConsentForm({ scopes, mandates }: { scopes: string[]; mandates: { id: string; name: string; agent: string }[] }) {
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [err, setErr] = useState("");

  async function decide(accept: boolean) {
    setBusy(accept ? "allow" : "deny");
    const { data, error } = await authClient.oauth2.consent({ accept, scope: scopes.join(" ") });
    if (error) { setErr(error.message ?? "Consent failed."); setBusy(null); return; }
    const uri = (data as { redirect_uri?: string } | null)?.redirect_uri;
    if (uri) window.location.href = uri; else setErr("No redirect returned; return to your agent and retry.");
  }

  return (
    <div className="card stack">
      <div>
        <div className="eyebrow" style={{ marginBottom: 6 }}>It is asking to</div>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {scopes.map((s) => <li key={s}>{SCOPE_TEXT[s] ?? s}</li>)}
        </ul>
      </div>
      <div>
        <div className="eyebrow" style={{ marginBottom: 6 }}>Mandates it will be able to use</div>
        {mandates.length === 0 ? <p className="muted" style={{ margin: 0 }}>No active mandates yet. You can allow now and issue one afterwards.</p> : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>{mandates.map((m) => <li key={m.id}>{m.name} <span className="faint">· {m.agent}</span></li>)}</ul>
        )}
      </div>
      {err && <div className="notice bad">{err}</div>}
      <div className="actions">
        <button className="btn accent" onClick={() => decide(true)} disabled={busy !== null}>{busy === "allow" ? "Connecting…" : "Allow"}</button>
        <button className="btn secondary" onClick={() => decide(false)} disabled={busy !== null}>Deny</button>
      </div>
      <p className="faint" style={{ fontSize: 12.5, margin: 0 }}>You can disconnect this agent at any time from Settings; revoking a mandate cuts it off immediately regardless.</p>
    </div>
  );
}
