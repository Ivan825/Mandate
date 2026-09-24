import { fmt } from "@/lib/policy";

export function Pill({ v }: { v: string }) {
  return <span className={`pill ${v}`}>{v}</span>;
}

export function Util({ used, limit, currency, label }: { used: number; limit: number; currency: string; label: string }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const cls = pct >= 90 ? "bad" : pct >= 65 ? "warn" : "";
  return (
    <div className="util">
      <div className="lbl"><span>{label}</span><span className="num">{pct}%</span></div>
      <div className="bar"><div className={`fill ${cls}`} style={{ width: `${pct}%` }} /></div>
      <div className="lbl"><span className="num">{fmt(used, currency)}</span><span className="num">of {fmt(limit, currency)}</span></div>
    </div>
  );
}

import { FLAG_LABELS, parseFlags } from "@/lib/anomaly";

// Anomaly chips for a decision or request; nothing when there are none.
export function Flags({ json, small }: { json: string | null | undefined; small?: boolean }) {
  const flags = parseFlags(json);
  if (flags.length === 0) return null;
  return <span className="flags">{flags.map((f) => <span key={f} className="flag" title={FLAG_LABELS[f].hint} style={small ? { fontSize: 10.5 } : undefined}>⚑ {FLAG_LABELS[f].label}</span>)}</span>;
}

export { When } from "./when";
