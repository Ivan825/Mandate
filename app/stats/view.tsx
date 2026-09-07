"use client";

import { useMemo, useState } from "react";
import type { StatRow } from "@/lib/stats";
import { fmt } from "@/lib/policy";

// Interactive statistics, computed in the browser from the workspace's
// decisions. Charts are plain SVG in the site's own palette; hover any mark
// for the exact figure; every chart has a table view.

type Grain = "day" | "week" | "month" | "year";
type Range = "7d" | "30d" | "90d" | "12m" | "all";
type MandateInfo = { id: string; name: string; agent: string; status: string; totalLimit: number; currency: string };

const RANGE_DAYS: Record<Range, number> = { "7d": 7, "30d": 30, "90d": 90, "12m": 365, all: 366 };
const DEFAULT_GRAIN: Record<Range, Grain> = { "7d": "day", "30d": "day", "90d": "week", "12m": "month", all: "month" };
const SERIES = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)", "var(--c5)"];

function startOf(ms: number, grain: Grain): number {
  const d = new Date(ms);
  if (grain === "day") return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (grain === "week") { const day = (d.getDay() + 6) % 7; return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day).getTime(); }
  if (grain === "month") return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  return new Date(d.getFullYear(), 0, 1).getTime();
}
function next(ms: number, grain: Grain): number {
  const d = new Date(ms);
  if (grain === "day") return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  if (grain === "week") return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7).getTime();
  if (grain === "month") return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  return new Date(d.getFullYear() + 1, 0, 1).getTime();
}
function label(ms: number, grain: Grain): string {
  const d = new Date(ms);
  if (grain === "day") return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  if (grain === "week") return "wk of " + d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  if (grain === "month") return d.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
  return String(d.getFullYear());
}
function pct(n: number, d: number) { return d > 0 ? Math.round((n / d) * 100) : 0; }

export function StatsView({ rows, mandates }: { rows: StatRow[]; mandates: MandateInfo[] }) {
  const currencies = useMemo(() => { const c = new Map<string, number>(); for (const r of rows) c.set(r.c, (c.get(r.c) ?? 0) + 1); return [...c.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]); }, [rows]);
  const [currency, setCurrency] = useState(currencies[0] ?? "USD");
  const [range, setRange] = useState<Range>("30d");
  const [grain, setGrain] = useState<Grain>("day");
  const [stackBy, setStackBy] = useState<"none" | "agent" | "merchant">("agent");
  const [tables, setTables] = useState(false);

  const model = useMemo(() => {
    const now = Date.now();
    const days = RANGE_DAYS[range];
    const from = range === "all" ? Math.min(now - days * 864e5, ...rows.map((r) => r.t)) : now - days * 864e5;
    const prevFrom = from - (now - from);
    const inRange = rows.filter((r) => r.c === currency && r.t >= from);
    const prev = rows.filter((r) => r.c === currency && r.t >= prevFrom && r.t < from);
    const approved = inRange.filter((r) => r.d === "approved");
    const spend = approved.reduce((s, r) => s + r.a, 0);
    const prevSpend = prev.filter((r) => r.d === "approved").reduce((s, r) => s + r.a, 0);
    const declined = inRange.filter((r) => r.d === "declined");
    const pending = inRange.filter((r) => r.d === "pending");

    // Time buckets, continuous across the range so quiet periods show as gaps.
    const buckets: { start: number; label: string; total: number; count: number; declined: number; pending: number; by: Map<string, number> }[] = [];
    for (let b = startOf(from, grain); b <= now; b = next(b, grain)) buckets.push({ start: b, label: label(b, grain), total: 0, count: 0, declined: 0, pending: 0, by: new Map() });
    const idx = (t: number) => { let i = buckets.length - 1; while (i > 0 && buckets[i].start > t) i--; return i; };
    const keyOf = (r: StatRow) => stackBy === "agent" ? r.ag : stackBy === "merchant" ? r.m : "all";
    for (const r of inRange) {
      const bk = buckets[idx(r.t)]; if (!bk) continue;
      if (r.d === "approved") { bk.total += r.a; bk.count++; bk.by.set(keyOf(r), (bk.by.get(keyOf(r)) ?? 0) + r.a); }
      else if (r.d === "declined") bk.declined++;
      else if (r.d === "pending") bk.pending++;
    }
    // Series: top 4 keys by spend, everything else folded into Other.
    const keyTotals = new Map<string, number>();
    for (const r of approved) keyTotals.set(keyOf(r), (keyTotals.get(keyOf(r)) ?? 0) + r.a);
    const ranked = [...keyTotals.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
    const keys = stackBy === "none" ? ["all"] : ranked.length > 5 ? [...ranked.slice(0, 4), "Other"] : ranked;
    const fold = (k: string) => keys.includes(k) ? k : "Other";
    for (const bk of buckets) { const m = new Map<string, number>(); for (const [k, v] of bk.by) m.set(fold(k), (m.get(fold(k)) ?? 0) + v); bk.by = m; }

    const byAgent = group(approved, (r) => r.ag);
    const byMerchant = group(approved, (r) => r.m);
    const byMandate = group(approved, (r) => r.md);
    const declineRules = group(declined, (r) => ruleWord(r.r), () => 1);
    const bySource = group(approved, (r) => r.s);

    // Weekday × hour heat: when do agents actually spend?
    const heat = Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
    for (const r of approved) { const d = new Date(r.t); heat[(d.getDay() + 6) % 7][d.getHours()] += r.a; }
    const heatMax = Math.max(0, ...heat.flat());

    // Daily run-rate and a straight-line projection for the current month.
    const elapsedDays = Math.max(1, (now - from) / 864e5);
    const perDay = spend / elapsedDays;
    const monthStart = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1).getTime();
    const monthSpend = rows.filter((r) => r.c === currency && r.d === "approved" && r.t >= monthStart).reduce((s, r) => s + r.a, 0);
    const daysInMonth = new Date(new Date(now).getFullYear(), new Date(now).getMonth() + 1, 0).getDate();
    const dayOfMonth = new Date(now).getDate();
    const projected = dayOfMonth > 0 ? Math.round((monthSpend / dayOfMonth) * daysInMonth) : 0;
    const activeMandates = mandates.filter((m) => m.status === "active" && m.currency === currency);
    const idle = activeMandates.filter((m) => !approved.some((r) => r.mid === m.id));
    const sanctioned = activeMandates.reduce((s, m) => s + m.totalLimit, 0);
    const busiest = buckets.reduce((best, b) => (b.total > (best?.total ?? -1) ? b : best), buckets[0]);

    return { from, inRange, approved, spend, prevSpend, declined, pending, buckets, keys, byAgent, byMerchant, byMandate, declineRules, bySource, heat, heatMax, perDay, monthSpend, projected, idle, sanctioned, busiest, activeMandates };
  }, [rows, mandates, currency, range, grain, stackBy]);

  const m = model;
  const delta = m.prevSpend > 0 ? Math.round(((m.spend - m.prevSpend) / m.prevSpend) * 100) : null;
  const avg = m.approved.length ? Math.round(m.spend / m.approved.length) : 0;
  const approvalRate = pct(m.approved.length, m.approved.length + m.declined.length);

  if (rows.length === 0) return <div className="card empty">No decisions yet. Once an agent asks to spend, the picture starts here.</div>;

  return (
    <div className="stats">
      <div className="filters">
        <div className="seg" role="group" aria-label="Range">
          {(["7d", "30d", "90d", "12m", "all"] as Range[]).map((r) => <button key={r} type="button" className={r === range ? "on" : ""} onClick={() => { setRange(r); setGrain(DEFAULT_GRAIN[r]); }}>{r === "all" ? "All" : r}</button>)}
        </div>
        <div className="seg" role="group" aria-label="Grain">
          {(["day", "week", "month", "year"] as Grain[]).map((g) => <button key={g} type="button" className={g === grain ? "on" : ""} onClick={() => setGrain(g)}>{g}</button>)}
        </div>
        <div className="seg" role="group" aria-label="Stack by">
          {(["agent", "merchant", "none"] as const).map((s) => <button key={s} type="button" className={s === stackBy ? "on" : ""} onClick={() => setStackBy(s)}>{s === "none" ? "total" : "by " + s}</button>)}
        </div>
        {currencies.length > 1 && <select value={currency} onChange={(e) => setCurrency(e.target.value)} aria-label="Currency" style={{ width: "auto" }}>{currencies.map((c) => <option key={c}>{c}</option>)}</select>}
        <div className="spacer" />
        <label className="check" style={{ fontSize: 13 }}><input type="checkbox" checked={tables} onChange={(e) => setTables(e.target.checked)} /> Tables</label>
      </div>

      <div className="kpis">
        <div className="kpi"><div className="eyebrow">Spent</div><div className="v num">{fmt(m.spend, currency)}</div><div className="s">{delta == null ? "no prior period to compare" : <><span style={{ color: delta > 0 ? "var(--warn)" : "var(--ok)" }}>{delta > 0 ? "▲" : delta < 0 ? "▼" : "•"} {Math.abs(delta)}%</span> vs previous {range === "all" ? "period" : range}</>}</div></div>
        <div className="kpi"><div className="eyebrow">Approved</div><div className="v num">{m.approved.length}</div><div className="s">avg {fmt(avg, currency)} per purchase</div></div>
        <div className="kpi"><div className="eyebrow">Approval rate</div><div className="v num">{approvalRate}%</div><div className="s">{m.declined.length} declined · {m.pending.length} escalated</div></div>
        <div className="kpi"><div className="eyebrow">Run-rate</div><div className="v num">{fmt(Math.round(m.perDay), currency)}<span className="faint" style={{ fontSize: 13, fontFamily: "var(--sans)", fontWeight: 400 }}>/day</span></div><div className="s">this month {fmt(m.monthSpend, currency)}, on course for {fmt(m.projected, currency)}</div></div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="chart-head"><h3>Spend over time</h3><span className="faint">{fmt(m.spend, currency)} across {m.buckets.length} {grain}{m.buckets.length === 1 ? "" : "s"}</span></div>
        {tables ? <BucketTable buckets={m.buckets} keys={m.keys} currency={currency} /> : <Bars buckets={m.buckets} keys={m.keys} currency={currency} />}
        {m.keys.length > 1 && <div className="legend">{m.keys.map((k, i) => <span key={k}><i style={{ background: SERIES[i] }} />{k}</span>)}</div>}
      </div>

      <div className="grid-2" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="chart-head"><h3>By agent</h3><span className="faint">share of approved spend</span></div>
          <HBars data={m.byAgent} total={m.spend} currency={currency} tables={tables} />
        </div>
        <div className="card">
          <div className="chart-head"><h3>Top merchants</h3><span className="faint">where it went</span></div>
          <HBars data={m.byMerchant.slice(0, 8)} total={m.spend} currency={currency} tables={tables} />
        </div>
      </div>

      <div className="grid-2" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="chart-head"><h3>Decisions</h3><span className="faint">approved · declined · escalated, per {grain}</span></div>
          {tables ? <DecisionTable buckets={m.buckets} /> : <Decisions buckets={m.buckets} />}
          {m.declineRules.length > 0 && <div className="reasons">{m.declineRules.slice(0, 5).map((d) => <span key={d.key} className="pill declined">{d.key} × {d.value}</span>)}</div>}
        </div>
        <div className="card">
          <div className="chart-head"><h3>When agents spend</h3><span className="faint">weekday × hour, your local time</span></div>
          {tables ? <p className="faint">Heat values are approved spend per weekday-hour cell; peak {fmt(m.heatMax, currency)}.</p> : <Heat heat={m.heat} max={m.heatMax} currency={currency} />}
        </div>
      </div>

      <div className="card">
        <div className="chart-head"><h3>Reading</h3><span className="faint">what the numbers say</span></div>
        <Analysis m={m} currency={currency} range={range} delta={delta} approvalRate={approvalRate} />
      </div>
    </div>
  );
}

// ---------- aggregation helpers ----------

function group(rows: StatRow[], key: (r: StatRow) => string, val: (r: StatRow) => number = (r) => r.a) {
  const map = new Map<string, number>();
  for (const r of rows) map.set(key(r), (map.get(key(r)) ?? 0) + val(r));
  return [...map.entries()].map(([k, v]) => ({ key: k, value: v })).sort((a, b) => b.value - a.value);
}
function ruleWord(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes("merchant")) return "merchant";
  if (r.includes("today's limit") || r.includes("daily")) return "daily limit";
  if (r.includes("per-transaction")) return "per-transaction";
  if (r.includes("total limit")) return "total limit";
  if (r.includes("balance")) return "balance";
  if (r.includes("hours")) return "hours";
  if (r.includes("category")) return "category";
  if (r.includes("expired") || r.includes("revoked")) return "status";
  if (r.includes("denied")) return "denied recently";
  return "other";
}

// ---------- charts ----------

type Bucket = { start: number; label: string; total: number; count: number; declined: number; pending: number; by: Map<string, number> };

function Bars({ buckets, keys, currency }: { buckets: Bucket[]; keys: string[]; currency: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720, H = 220, padL = 64, padB = 26, padT = 12;
  const max = Math.max(1, ...buckets.map((b) => b.total));
  const n = buckets.length;
  const slot = (W - padL) / n;
  const bw = Math.max(3, Math.min(36, slot - 4));
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / max);
  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f));
  const every = Math.ceil(n / 8);
  return (
    <div className="chart-wrap" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Spend per period">
        {ticks.map((t) => <g key={t}><line x1={padL} x2={W} y1={y(t)} y2={y(t)} className="grid" /><text x={padL - 8} y={y(t) + 3} className="tick" textAnchor="end">{fmt(t, currency)}</text></g>)}
        {buckets.map((b, i) => {
          const x = padL + i * slot + (slot - bw) / 2;
          let acc = 0;
          const segs = keys.map((k, ki) => { const v = b.by.get(k) ?? 0; const s = { k, ki, v, y0: acc, y1: acc + v }; acc += v; return s; }).filter((s) => s.v > 0);
          return (
            <g key={b.start} onMouseEnter={() => setHover(i)} style={{ cursor: "default" }}>
              <rect x={padL + i * slot} y={padT} width={slot} height={H - padT - padB} fill="transparent" />
              {segs.map((s, si) => <rect key={s.k} x={x} y={y(s.y1)} width={bw} height={Math.max(0, y(s.y0) - y(s.y1) - (si < segs.length - 1 ? 2 : 0))} rx={si === segs.length - 1 ? 3 : 0} fill={SERIES[s.ki]} opacity={hover == null || hover === i ? 1 : 0.45} />)}
              {i % every === 0 && <text x={padL + i * slot + slot / 2} y={H - 8} className="tick" textAnchor="middle">{b.label}</text>}
            </g>
          );
        })}
      </svg>
      {hover != null && buckets[hover] && (
        <div className="tip" style={{ left: `${((padL + hover * slot + slot / 2) / W) * 100}%` }}>
          <div className="tip-h">{buckets[hover].label}</div>
          <div className="num"><strong>{fmt(buckets[hover].total, currency)}</strong> · {buckets[hover].count} approved</div>
          {keys.length > 1 && [...buckets[hover].by.entries()].filter((e) => e[1] > 0).map(([k, v]) => <div key={k} className="num"><i style={{ background: SERIES[keys.indexOf(k)] }} />{k}: {fmt(v, currency)}</div>)}
          {(buckets[hover].declined > 0 || buckets[hover].pending > 0) && <div className="faint">{buckets[hover].declined} declined · {buckets[hover].pending} escalated</div>}
        </div>
      )}
    </div>
  );
}

function HBars({ data, total, currency, tables }: { data: { key: string; value: number }[]; total: number; currency: string; tables: boolean }) {
  if (data.length === 0) return <p className="faint">Nothing approved in this range.</p>;
  if (tables) return <table className="mini"><tbody>{data.map((d) => <tr key={d.key}><td>{d.key}</td><td className="r num">{fmt(d.value, currency)}</td><td className="r num faint">{pct(d.value, total)}%</td></tr>)}</tbody></table>;
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="hbars">
      {data.map((d, i) => (
        <div key={d.key} className="hbar" title={`${d.key}: ${fmt(d.value, currency)} (${pct(d.value, total)}%)`}>
          <div className="hbar-l"><span>{d.key}</span><span className="num faint">{fmt(d.value, currency)} · {pct(d.value, total)}%</span></div>
          <div className="hbar-t"><div className="hbar-f" style={{ width: `${(d.value / max) * 100}%`, background: SERIES[Math.min(i, 4)] }} /></div>
        </div>
      ))}
    </div>
  );
}

function Decisions({ buckets }: { buckets: Bucket[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 360, H = 150, padB = 22, padT = 8;
  const max = Math.max(1, ...buckets.map((b) => b.count + b.declined + b.pending));
  const n = buckets.length, slot = W / n, bw = Math.max(3, Math.min(28, slot - 3));
  const h = (v: number) => (H - padT - padB) * (v / max);
  const every = Math.ceil(n / 4);
  return (
    <div className="chart-wrap" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Decisions per period">
        {buckets.map((b, i) => {
          const x = i * slot + (slot - bw) / 2; const base = H - padB;
          const segs = [["approved", b.count, "var(--ok)"], ["declined", b.declined, "var(--bad)"], ["pending", b.pending, "var(--warn)"]] as const;
          let yTop = base;
          return (
            <g key={b.start} onMouseEnter={() => setHover(i)}>
              <rect x={i * slot} y={padT} width={slot} height={H - padT - padB} fill="transparent" />
              {segs.filter((s) => s[1] > 0).map((s, si, arr) => { const hh = h(s[1]); yTop -= hh; return <rect key={s[0]} x={x} y={yTop} width={bw} height={Math.max(0, hh - (si < arr.length - 1 ? 2 : 0))} rx={si === arr.length - 1 ? 3 : 0} fill={s[2]} opacity={hover == null || hover === i ? 1 : 0.45} />; })}
              {i % every === 0 && <text x={i * slot + slot / 2} y={H - 6} className="tick" textAnchor="middle">{b.label.replace(/^wk of /, "")}</text>}
            </g>
          );
        })}
      </svg>
      {hover != null && buckets[hover] && <div className="tip" style={{ left: `${((hover * slot + slot / 2) / W) * 100}%` }}><div className="tip-h">{buckets[hover].label}</div><div className="num"><i style={{ background: "var(--ok)" }} />{buckets[hover].count} approved</div><div className="num"><i style={{ background: "var(--bad)" }} />{buckets[hover].declined} declined</div><div className="num"><i style={{ background: "var(--warn)" }} />{buckets[hover].pending} escalated</div></div>}
      <div className="legend"><span><i style={{ background: "var(--ok)" }} />approved</span><span><i style={{ background: "var(--bad)" }} />declined</span><span><i style={{ background: "var(--warn)" }} />escalated</span></div>
    </div>
  );
}

function Heat({ heat, max, currency }: { heat: number[][]; max: number; currency: string }) {
  const [hover, setHover] = useState<{ d: number; h: number } | null>(null);
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const W = 360, H = 150, padL = 30, padT = 4, padB = 18;
  const cw = (W - padL) / 24, ch = (H - padT - padB) / 7;
  return (
    <div className="chart-wrap" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Spend by weekday and hour">
        {days.map((d, di) => <text key={d} x={padL - 6} y={padT + di * ch + ch / 2 + 3} className="tick" textAnchor="end">{d}</text>)}
        {[0, 6, 12, 18].map((hh) => <text key={hh} x={padL + hh * cw + cw / 2} y={H - 5} className="tick" textAnchor="middle">{String(hh).padStart(2, "0")}h</text>)}
        {heat.map((row, di) => row.map((v, hi) => (
          <rect key={`${di}-${hi}`} x={padL + hi * cw + 1} y={padT + di * ch + 1} width={cw - 2} height={ch - 2} rx={2}
            fill="var(--c1)" opacity={max > 0 && v > 0 ? 0.18 + 0.82 * (v / max) : 0.06} onMouseEnter={() => setHover({ d: di, h: hi })} />
        )))}
      </svg>
      {hover && <div className="tip" style={{ left: `${((padL + hover.h * cw + cw / 2) / W) * 100}%` }}><div className="tip-h">{days[hover.d]} {String(hover.h).padStart(2, "0")}:00–{String(hover.h + 1).padStart(2, "0")}:00</div><div className="num"><strong>{fmt(heat[hover.d][hover.h], currency)}</strong></div></div>}
    </div>
  );
}

function BucketTable({ buckets, keys, currency }: { buckets: Bucket[]; keys: string[]; currency: string }) {
  return <div className="tbl" style={{ border: "none" }}><table className="mini"><thead><tr><th>Period</th><th className="r">Spend</th><th className="r">Approved</th>{keys.length > 1 && keys.map((k) => <th key={k} className="r">{k}</th>)}</tr></thead><tbody>{buckets.map((b) => <tr key={b.start}><td>{b.label}</td><td className="r num">{fmt(b.total, currency)}</td><td className="r num">{b.count}</td>{keys.length > 1 && keys.map((k) => <td key={k} className="r num">{fmt(b.by.get(k) ?? 0, currency)}</td>)}</tr>)}</tbody></table></div>;
}
function DecisionTable({ buckets }: { buckets: Bucket[] }) {
  return <table className="mini"><thead><tr><th>Period</th><th className="r">Approved</th><th className="r">Declined</th><th className="r">Escalated</th></tr></thead><tbody>{buckets.map((b) => <tr key={b.start}><td>{b.label}</td><td className="r num">{b.count}</td><td className="r num">{b.declined}</td><td className="r num">{b.pending}</td></tr>)}</tbody></table>;
}

// ---------- the written reading ----------

function Analysis({ m, currency, range, delta, approvalRate }: { m: ReturnType<typeof modelShape>; currency: string; range: Range; delta: number | null; approvalRate: number }) {
  const lines: string[] = [];
  const period = range === "all" ? "the whole period" : `the last ${range}`;
  if (m.approved.length === 0) lines.push(`Nothing was approved in ${period}${m.declined.length ? `, but ${m.declined.length} request${m.declined.length === 1 ? " was" : "s were"} declined — the terms are doing the work, or they are too tight.` : "."}`);
  else {
    lines.push(`Agents spent ${fmt(m.spend, currency)} in ${period} across ${m.approved.length} approved purchase${m.approved.length === 1 ? "" : "s"}${delta == null ? "" : delta === 0 ? ", level with the period before" : `, ${Math.abs(delta)}% ${delta > 0 ? "more" : "less"} than the period before`}.`);
    const top = m.byAgent[0];
    if (top && m.byAgent.length > 1) lines.push(`${top.key} accounts for ${pct(top.value, m.spend)}% of it${pct(top.value, m.spend) >= 70 ? " — one agent dominates; if that is not by design, its mandate is where a tighter total limit would matter most" : ""}.`);
    const merch = m.byMerchant[0];
    if (merch) lines.push(`The single biggest merchant is ${merch.key} at ${fmt(merch.value, currency)} (${pct(merch.value, m.spend)}%)${m.byMerchant.length > 1 ? `; the top three cover ${pct(m.byMerchant.slice(0, 3).reduce((s, d) => s + d.value, 0), m.spend)}% of spend` : ""}.`);
    if (m.busiest && m.busiest.total > 0) lines.push(`The busiest period was ${m.busiest.label} with ${fmt(m.busiest.total, currency)}${m.buckets.length > 2 ? `, against an average of ${fmt(Math.round(m.spend / m.buckets.length), currency)}` : ""}.`);
    if (m.projected > 0) lines.push(`At this month's pace, spend lands near ${fmt(m.projected, currency)} by month end${m.sanctioned > 0 ? (m.projected > m.sanctioned ? `, which is more than the ${fmt(m.sanctioned, currency)} sanctioned across active mandates — the total limits will stop it before then, so expect declines unless you renew` : `, ${pct(m.projected, m.sanctioned)}% of the ${fmt(m.sanctioned, currency)} sanctioned across active mandates`) : ""}.`);
  }
  if (m.declined.length > 0) {
    const r = m.declineRules[0];
    lines.push(`${m.declined.length} request${m.declined.length === 1 ? " was" : "s were"} declined (approval rate ${approvalRate}%)${r ? `, most often on the ${r.key} rule (${r.value})` : ""}${r?.key === "merchant" ? " — agents are trying merchants outside the allow-list; either add them or leave it, that is the point of the list" : r?.key === "daily limit" ? " — the daily cap is binding; raise it only if the work genuinely needs it" : r?.key === "balance" ? " — cards are running dry; add funds on the Balance page" : ""}.`);
  }
  if (m.pending.length > 0) lines.push(`${m.pending.length} request${m.pending.length === 1 ? "" : "s"} went to a human for approval; if that number is high and you approve almost all of them, the escalation threshold may be lower than it needs to be.`);
  if (m.idle.length > 0) lines.push(`${m.idle.length} active mandate${m.idle.length === 1 ? " has" : "s have"} no approved spend in this range (${m.idle.slice(0, 3).map((x) => x.name).join(", ")}${m.idle.length > 3 ? ", …" : ""}); unused authority is exposure for nothing — consider revoking.`);
  const src = m.bySource.map((s) => `${sourceWord(s.key)} ${pct(s.value, m.spend)}%`).join(", ");
  if (m.bySource.length > 1) lines.push(`By rail: ${src}.`);
  return <div className="reading">{lines.map((l, i) => <p key={i}>{l}</p>)}</div>;
}
function sourceWord(s: string) { return ({ agent_api: "REST API", mcp: "MCP", proxy: "API proxy", stripe: "cards", simulation: "test purchases" } as Record<string, string>)[s] ?? s; }
// Type helper so Analysis can take the memoised model.
function modelShape() { return null as unknown as { approved: StatRow[]; declined: StatRow[]; pending: StatRow[]; spend: number; byAgent: { key: string; value: number }[]; byMerchant: { key: string; value: number }[]; declineRules: { key: string; value: number }[]; bySource: { key: string; value: number }[]; busiest: Bucket | undefined; buckets: Bucket[]; projected: number; sanctioned: number; idle: MandateInfo[] }; }
