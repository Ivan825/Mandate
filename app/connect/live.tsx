"use client";

import { useEffect, useRef, useState } from "react";

type Status = { lastCall: null | { at: string; source: string; actor: string; decision: string; rule: string; amount: string; merchant: string; agent: string; mandate: string; settlement: string | null }; connected: { name: string; scopes: string[]; grantedAt: string }[] };

// "Is it working?" — polls for the first call after this page was opened
// and says so the moment it lands. Stops polling once seen or after an hour.
export function LiveCheck({ mandateId, rail }: { mandateId: string | null; rail: string }) {
  const since = useRef(new Date().toISOString());
  const [st, setSt] = useState<Status | null>(null);
  const [seen, setSeen] = useState(false);
  const [ticks, setTicks] = useState(0);
  useEffect(() => {
    let stop = false;
    const poll = async () => {
      if (stop || document.visibilityState !== "visible") return;
      try {
        const r: Status = await fetch(`/api/connect/status?since=${encodeURIComponent(since.current)}${mandateId ? `&mandate=${mandateId}` : ""}`, { cache: "no-store" }).then((x) => x.json());
        setSt(r);
        if (r.lastCall) { setSeen(true); stop = true; }
      } catch { /* try again */ }
      setTicks((n) => n + 1);
    };
    poll();
    const id = setInterval(() => { if (ticks < 1200) poll(); }, 3000);
    return () => { stop = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mandateId]);
  const oauth = rail === "claude" || rail === "claude-code" || rail === "cursor";
  return (
    <div className="card" style={{ position: "sticky", top: 76 }}>
      <div className="eyebrow">Live check</div>
      {seen && st?.lastCall ? (
        <div className="notice ok" style={{ marginTop: 8 }}>
          <strong>It works.</strong> {st.lastCall.agent} asked for {st.lastCall.amount} at {st.lastCall.merchant} via {st.lastCall.source === "agent_api" ? "the API" : st.lastCall.source}{st.lastCall.actor ? ` (${st.lastCall.actor})` : ""} at {new Date(st.lastCall.at).toLocaleTimeString()} — <span className={`pill ${st.lastCall.decision}`}>{st.lastCall.decision}</span>
          <div className="faint" style={{ fontSize: 12.5, marginTop: 6 }}>{st.lastCall.rule}</div>
        </div>
      ) : (
        <div style={{ marginTop: 8 }}>
          <div className="pulse"><span /> Waiting for the first call{mandateId ? " on this mandate" : ""}…</div>
          <p className="faint" style={{ fontSize: 12.5, margin: "8px 0 0" }}>Run the snippet on the left (or ask the connected agent to check its budget and request a small purchase). This box updates on its own.</p>
        </div>
      )}
      {oauth && st && (
        <div style={{ marginTop: 12 }}>
          <div className="eyebrow" style={{ fontSize: 11 }}>Connected through OAuth</div>
          {st.connected.length === 0 ? <div className="faint" style={{ fontSize: 12.5 }}>Nothing yet. Once you approve the consent page, the agent shows up here.</div> : st.connected.map((c) => <div key={c.name + c.grantedAt} style={{ fontSize: 13 }}>✓ {c.name} <span className="faint mono" style={{ fontSize: 11 }}>{c.scopes.join(" ")}</span></div>)}
        </div>
      )}
    </div>
  );
}
