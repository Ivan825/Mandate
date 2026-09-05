import Link from "next/link";
import { exposureBook, recentTransactions, listAgents } from "@/lib/service";
import { fmt } from "@/lib/policy";
import { Pill, Util, When } from "./components";

export default async function ExposurePage() {
  const [book, recent, agents] = await Promise.all([exposureBook(), recentTransactions(12), listAgents()]);
  const active = book.filter((b) => b.mandate.status === "active");
  const byCcy = new Map<string, { limit: number; used: number }>();
  for (const b of active) {
    const c = byCcy.get(b.mandate.currency) ?? { limit: 0, used: 0 };
    c.limit += b.mandate.totalLimit; c.used += b.spentTotal;
    byCcy.set(b.mandate.currency, c);
  }
  const pending = book.reduce((n, b) => n + b.pendingApprovals, 0);
  const declinedToday = book.reduce((n, b) => n + b.declinedToday, 0);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Exposure book</div>
          <h1>What your agents may spend, and what they have</h1>
          <p className="muted">Every agent holds a mandate, not a card. Limits, scope and escalation are enforced on each attempt; everything is written to the ledger.</p>
        </div>
        <div className="actions">
          <Link href="/agents/new" className="btn secondary">Add agent</Link>
          <Link href="/mandates/new" className="btn accent">Issue mandate</Link>
        </div>
      </div>

      <div className="kpis">
        <div className="kpi"><div className="eyebrow">Active mandates</div><div className="v num">{active.length}</div><div className="s">{agents.length} agent{agents.length === 1 ? "" : "s"} · {book.length - active.length} revoked</div></div>
        <div className="kpi"><div className="eyebrow">Sanctioned limit</div>
          <div className="v num">{[...byCcy].map(([c, v]) => fmt(v.limit, c)).join(" + ") || "—"}</div>
          <div className="s">total across active mandates</div></div>
        <div className="kpi"><div className="eyebrow">Utilised</div>
          <div className="v num">{[...byCcy].map(([c, v]) => fmt(v.used, c)).join(" + ") || "—"}</div>
          <div className="s">{[...byCcy].map(([, v]) => v.limit ? Math.round((v.used / v.limit) * 100) + "%" : "0%").join(" · ") || "0%"} of sanctioned</div></div>
        <div className="kpi"><div className="eyebrow">Needs you</div><div className="v num">{pending}</div><div className="s">{pending ? <Link href="/approvals">awaiting approval</Link> : "no pending approvals"} · {declinedToday} declined today</div></div>
      </div>

      <div className="tbl">
        <table>
          <thead><tr><th>Agent · mandate</th><th>Status</th><th>Today</th><th>Lifetime</th><th className="r">Per txn</th><th className="r">Ask above</th><th>Last activity</th></tr></thead>
          <tbody>
            {book.length === 0 && (
              <tr><td colSpan={7} className="empty">No mandates yet. <Link href="/agents/new">Add an agent</Link>, then issue it a mandate.</td></tr>
            )}
            {book.map((b) => (
              <tr key={b.mandate.id}>
                <td>
                  <div style={{ fontWeight: 500 }}>{b.agentName}</div>
                  <Link href={`/mandates/${b.mandate.id}`}>{b.mandate.name}</Link>
                  {b.mandate.cardLast4 && <span className="faint mono"> · card ···{b.mandate.cardLast4}</span>}
                </td>
                <td><Pill v={b.mandate.status} />{b.pendingApprovals > 0 && <div style={{ marginTop: 4 }}><Pill v="pending" /> <span className="faint num">{b.pendingApprovals}</span></div>}</td>
                <td><Util used={b.spentToday} limit={b.mandate.dailyLimit} currency={b.mandate.currency} label="daily" /></td>
                <td><Util used={b.spentTotal} limit={b.mandate.totalLimit} currency={b.mandate.currency} label="total" /></td>
                <td className="r num">{fmt(b.mandate.perTxnLimit, b.mandate.currency)}</td>
                <td className="r num">{b.mandate.approvalAbove == null ? <span className="faint">never</span> : fmt(b.mandate.approvalAbove, b.mandate.currency)}</td>
                <td><When d={b.lastActivity} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 style={{ margin: "36px 0 12px" }}>Recent decisions</h2>
      <div className="tbl">
        <table>
          <thead><tr><th>When</th><th>Agent</th><th>Merchant</th><th className="r">Amount</th><th>Decision</th><th>Reason</th><th>Via</th></tr></thead>
          <tbody>
            {recent.length === 0 && <tr><td colSpan={7} className="empty">No activity yet. Open a mandate and simulate a purchase, or call the agent API.</td></tr>}
            {recent.map(({ t, agentName, mandateName }) => (
              <tr key={t.id}>
                <td><When d={t.createdAt} /></td>
                <td>{agentName}<div className="faint" style={{ fontSize: 12 }}>{mandateName}</div></td>
                <td>{t.merchant}{t.purpose && <div className="faint" style={{ fontSize: 12 }}>{t.purpose}</div>}</td>
                <td className="r num">{fmt(t.amount, t.currency)}</td>
                <td><Pill v={t.decision} /></td>
                <td className="muted" style={{ maxWidth: 320 }}>{t.reason}</td>
                <td className="mono faint">{t.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
