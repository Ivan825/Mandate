"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { bindAgentAction } from "@/app/actions";

const SCOPE_TEXT: Record<string, string> = {
  "mandate:read": "See your mandates and what is left on each",
  "mandate:spend": "Ask to spend under a mandate (subject to its limits and your approvals)",
  openid: "Know who you are (your user id)",
  profile: "See your name",
  email: "See your email address",
  offline_access: "Stay connected without asking you to sign in again",
};

export function ConsentForm({ clientId, scopes, mandates, canSpend }: { clientId: string; scopes: string[]; mandates: { id: string; name: string; agent: string }[]; canSpend: boolean }) {
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [err, setErr] = useState("");
  const wantsSpend = scopes.includes("mandate:spend");

  async function decide(accept: boolean) {
    setBusy(accept ? "allow" : "deny");
    setErr("");
    const { data, error } = await authClient.oauth2.consent({ accept, scope: scopes.join(" ") });
    if (error) { setErr(error.message ?? "Consent failed."); setBusy(null); return; }
    if (accept) {
      // Consent is recorded; pin the agent to this workspace before the
      // agent exchanges its code for a token.
      const bound = await bindAgentAction(clientId);
      if (!bound.ok) { setErr(bound.error); setBusy(null); return; }
    }
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
      {wantsSpend && !canSpend && <div className="notice">Your role in this workspace cannot let an agent spend. Switch to a workspace where you are an owner or admin from the top bar, then return to the agent and connect again.</div>}
      {err && <div className="notice bad">{err}</div>}
      <div className="actions">
        <button className="btn accent" onClick={() => decide(true)} disabled={busy !== null || (wantsSpend && !canSpend)}>{busy === "allow" ? "Connecting…" : "Allow"}</button>
        <button className="btn secondary" onClick={() => decide(false)} disabled={busy !== null}>Deny</button>
      </div>
      <p className="faint" style={{ fontSize: 12.5, margin: 0 }}>You can disconnect this agent at any time from Settings; revoking a mandate cuts it off immediately regardless.</p>
    </div>
  );
}
