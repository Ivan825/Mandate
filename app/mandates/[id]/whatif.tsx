"use client";

import { useState } from "react";
import { fmt, toMajor, toMinor, inputStep } from "@/lib/money";

type Outcome = { id: string; decision: string; rule: string; actual: string; changed: boolean; amount: number; merchant: string; purpose: string; at: string; source: string };
type Result = { outcomes: Outcome[]; counts: Record<string, number>; changed: number; requests: number };

// Policy time-travel: change the terms, replay the mandate's real history
// through the real engine, see which decisions would have gone the other way.
export function WhatIf({ mandateId, currency, initial }: { mandateId: string; currency: string; initial: { perTxnLimit: number; dailyLimit: number; totalLimit: number; approvalAbove: number | null; allowedMerchants: string[] } }) {
  const [perTxn, setPerTxn] = useState(String(toMajor(initial.perTxnLimit, currency)));
  const [daily, setDaily] = useState(String(toMajor(initial.dailyLimit, currency)));
  const [total, setTotal] = useState(String(toMajor(initial.totalLimit, currency)));
  const [ask, setAsk] = useState(initial.approvalAbove == null ? "" : String(toMajor(initial.approvalAbove, currency)));
  const [merchants, setMerchants] = useState(initial.allowedMerchants.join(", "));
  const [res, setRes] = useState<Result | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [onlyChanged, setOnlyChanged] = useState(true);
  const step = inputStep(currency);
  async function run() {
    setBusy(true); setErr("");
    try {
      const body = { perTxnLimit: toMinor(Number(perTxn), currency), dailyLimit: toMinor(Number(daily), currency), totalLimit: toMinor(Number(total), currency), approvalAbove: ask.trim() === "" ? null : toMinor(Number(ask), currency), allowedMerchants: merchants.split(/[,\n]/).map((s) => s.trim()).filter(Boolean) };
      const r = await fetch(`/api/mandates/${mandateId}/replay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) { setErr(j.error ?? "Could not replay."); return; }
      setRes(j);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  const rows = res ? res.outcomes.filter((o) => !onlyChanged || o.changed) : [];
  return (
    <div className="card stack">
      <div><div className="eyebrow">What if… (policy time-travel)</div><p className="muted" style={{ fontSize: 13.5, margin: "4px 0 0" }}>Change the terms and replay this mandate's real history through the real engine. Nothing is changed; you see which past decisions would have gone the other way.</p></div>
      <div className="row-3">
        <div className="field"><label>Per transaction</label><input type="number" step={step} value={perTxn} onChange={(e) => setPerTxn(e.target.value)} /></div>
        <div className="field"><label>Per day</label><input type="number" step={step} value={daily} onChange={(e) => setDaily(e.target.value)} /></div>
        <div className="field"><label>Total</label><input type="number" step={step} value={total} onChange={(e) => setTotal(e.target.value)} /></div>
      </div>
      <div className="row">
        <div className="field"><label>Ask me above (blank = never)</label><input type="number" step={step} value={ask} onChange={(e) => setAsk(e.target.value)} /></div>
        <div className="field"><label>Allowed merchants (comma-separated, blank = any)</label><input value={merchants} onChange={(e) => setMerchants(e.target.value)} /></div>
      </div>
      <div className="actions"><button type="button" className="btn secondary sm" onClick={run} disabled={busy}>{busy ? "Replaying…" : "Replay history"}</button>{res && <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} /> only what changes</label>}</div>
      {err && <div className="notice bad">{err}</div>}
      {res && (
        <>
          <div className="notice">{res.requests === 0 ? "No real requests to replay yet (simulations are left out)." : <>Under these terms, of <strong>{res.requests}</strong> past requests: <strong>{res.counts.approved ?? 0}</strong> approved, <strong>{res.counts.declined ?? 0}</strong> declined, <strong>{res.counts.pending ?? 0}</strong> would have asked — <strong>{res.changed}</strong> {res.changed === 1 ? "decision" : "decisions"} different from what actually happened.</>}</div>
          {rows.length > 0 && (
            <div className="tbl"><table className="mini">
              <thead><tr><th>When</th><th>Request</th><th>Actually</th><th>Would be</th></tr></thead>
              <tbody>{rows.slice(0, 100).map((o) => <tr key={o.id}><td style={{ whiteSpace: "nowrap" }}>{new Date(o.at).toLocaleString()}</td><td>{fmt(o.amount, currency)} at {o.merchant}{o.purpose && <span className="faint"> — {o.purpose}</span>}</td><td><span className={`pill ${o.actual}`}>{o.actual}</span></td><td><span className={`pill ${o.decision}`}>{o.decision}</span> <span className="faint mono" style={{ fontSize: 11 }}>{o.rule}</span></td></tr>)}</tbody>
            </table></div>
          )}
        </>
      )}
    </div>
  );
}
