import Link from "next/link";
import { getCtx } from "@/lib/session";
import { Landing } from "./landing";
import { exposureBook, recentTransactions, listAgents } from "@/lib/service";
import { fmt } from "@/lib/policy";
import { Pill, Util, When } from "./components";
import { appUrl } from "@/lib/env";

export default async function ExposurePage({ searchParams }: { searchParams: Promise<{ joined?: string; left?: string; deleted?: string; error?: string }> }) {
  const ctx = await getCtx();
  if (!ctx) return <Landing base={appUrl()} />;
  const { joined, left, deleted, error } = await searchParams;
  const [book, recent, agents] = await Promise.all([exposureBook(ctx.workspaceId), recentTransactions(ctx.workspaceId, 12), listAgents(ctx.workspaceId)]);
  const active = book.filter((b) => b.effectiveStatus === "active");
  const byCcy = new Map<string, { limit: number; used: number }>();
  for (const b of active) {
    const c = byCcy.get(b.mandate.currency) ?? { limit: 0, used: 0 };
    c.limit += b.mandate.totalLimit; c.used += b.spentTotal;
    byCcy.set(b.mandate.currency, c);
  }
  const pending = book.reduce((n, b) => n + b.pendingApprovals, 0);
  const declinedToday = book.reduce((n, b) => n + b.declinedToday, 0);

  if (book.length === 0) {
    const canIssue = ctx.role === "owner" || ctx.role === "admin";
    return (
      <div style={{ maxWidth: 680 }}>
        {(left || deleted) && <div className="notice ok" style={{ marginBottom: 16 }}>{deleted ? "Workspace deleted." : "You left the workspace."} You're now in <strong>{ctx.workspaceName}</strong>.</div>}
        <div className="eyebrow">Welcome to {ctx.workspaceName}</div>
        <h1>Give your agents a sanction, not a card</h1>
        <p className="muted" style={{ margin: "10px 0 20px" }}>Four short steps and your first agent is spending under terms you set.</p>
        <ol className="steps">
          <li className={agents.length ? "done" : ""}><strong>Add an agent</strong> — anything that acts for you: a shopping agent, Claude Code, a research assistant. {canIssue && agents.length === 0 && <Link href="/agents/new">Add one</Link>}</li>
          <li><strong>Issue it a mandate</strong> — limits, merchants, hours, and the amount above which it must ask you. {canIssue && agents.length > 0 && <Link href="/mandates/new">Issue one</Link>}</li>
          <li><strong>Tell Mandate how to reach you</strong> — an email address or a webhook, so approvals reach you wherever you already look. <Link href="/settings">Settings</Link></li>
          <li><strong>Connect the agent</strong> — one click from Claude, ChatGPT or Cursor, or a token for your own code. <Link href="/docs">Connect agents</Link></li>
        </ol>
        {!canIssue && <p className="faint">You're a {ctx.role} here; an owner or admin issues the mandates.</p>}
      </div>
    );
  }

  return (
    <>
      {(left || deleted) && <div className="notice ok" style={{ marginBottom: 16 }}>{deleted ? "Workspace deleted." : "You left the workspace."} You're now in <strong>{ctx.workspaceName}</strong>.</div>}
      {error && <div className="notice bad" style={{ marginBottom: 16 }}>{error}</div>}
      {joined && <div className="notice ok" style={{ marginBottom: 16 }}>You've joined <strong>{ctx.workspaceName}</strong>. Requests that need a decision will reach you through the channels in Settings.</div>}
      <div className="page-head">
        <div>
          <div className="eyebrow">Exposure book</div>
          <h1>What your agents may spend, and what they have</h1>
          <p className="muted">Every agent holds a mandate, not a card. Limits, scope and escalation are enforced on each attempt; everything is written to the ledger.</p>
        </div>
        {(ctx.role === "owner" || ctx.role === "admin") && (
          <div className="actions">
            <Link href="/agents/new" className="btn secondary">Add agent</Link>
            <Link href="/mandates/new" className="btn accent">Issue mandate</Link>
          </div>
        )}
      </div>

      <div className="kpis">
        <div className="kpi"><div className="eyebrow">Active mandates</div><div className="v num">{active.length}</div><div className="s">{agents.length} agent{agents.length === 1 ? "" : "s"} · {book.length - active.length} revoked or expired</div></div>
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
              <tr><td colSpan={7} className="empty">No mandates yet. <Link href="/mandates/new">Issue one</Link> to an agent.</td></tr>
            )}
            {book.map((b) => (
              <tr key={b.mandate.id}>
                <td>
                  <div style={{ fontWeight: 500 }}>{b.agentName}</div>
                  <Link href={`/mandates/${b.mandate.id}`}>{b.mandate.name}</Link>
                  {b.mandate.cardLast4 && <span className="faint mono"> · card ···{b.mandate.cardLast4}</span>}
                </td>
                <td><Pill v={b.effectiveStatus} />{b.pendingApprovals > 0 && <div style={{ marginTop: 4 }}><Pill v="pending" /> <span className="faint num">{b.pendingApprovals}</span></div>}</td>
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
            {recent.length === 0 && <tr><td colSpan={7} className="empty">No activity yet. Open a mandate and try a purchase, or connect an agent.</td></tr>}
            {recent.map(({ t, agentName, mandateName }) => (
              <tr key={t.id}>
                <td><When d={t.createdAt} /></td>
                <td>{agentName}<div className="faint" style={{ fontSize: 12 }}>{mandateName}</div></td>
                <td>{t.merchant}{t.purpose && <div className="faint" style={{ fontSize: 12 }}>{t.purpose}</div>}</td>
                <td className="r num">{fmt(t.amount, t.currency)}</td>
                <td><Pill v={t.decision} /></td>
                <td className="muted" style={{ maxWidth: 320 }}>{t.reason}</td>
                <td className="mono faint">{t.source}{t.actor && <div title={t.actor} style={{ fontSize: 11 }}>{t.actor.slice(0, 22)}</div>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
