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

export function When({ d }: { d: Date | number | string | null }) {
  if (!d) return <span className="faint">—</span>;
  const date = new Date(d);
  return <span className="num" title={date.toISOString()}>{date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })}</span>;
}
