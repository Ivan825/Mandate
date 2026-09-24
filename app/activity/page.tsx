import Link from "next/link";
import { requireCtx } from "@/lib/session";
import { listActivity, GROUPS, type Group } from "@/lib/activity";
import { listAgents, listMandates } from "@/lib/service";
import { fmt } from "@/lib/money";
import { Pill, When } from "@/app/components";
import { addNoteAction, removeNoteAction } from "@/app/actions";

export const metadata = { title: "Activity" };

type Q = { q?: string; group?: string; outcome?: string; mandate?: string; agent?: string; from?: string; to?: string; before?: string; error?: string };

const OUTCOMES = ["approved", "declined", "pending", "captured", "voided"];

export default async function ActivityPage({ searchParams }: { searchParams: Promise<Q> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const group = (GROUPS.some((g) => g.key === sp.group) ? sp.group : "") as Group | "";
  const outcome = OUTCOMES.includes(sp.outcome ?? "") ? sp.outcome! : "";
  const isId = (s?: string) => Boolean(s && /^[0-9a-f-]{36}$/i.test(s));
  const day = (s?: string, end = false) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + (end ? "T23:59:59.999Z" : "T00:00:00.000Z")) : null);
  const before = sp.before && /^\d+$/.test(sp.before) ? Number(sp.before) : null;
  const [feed, agents, mandates] = await Promise.all([
    listActivity(ctx.workspaceId, { q: sp.q, group, outcome, mandateId: isId(sp.mandate) ? sp.mandate : undefined, agentId: isId(sp.agent) ? sp.agent : undefined, from: day(sp.from), to: day(sp.to, true), before, limit: 60 }),
    listAgents(ctx.workspaceId), listMandates(ctx.workspaceId),
  ]);
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries({ q: sp.q, group, outcome, mandate: sp.mandate, agent: sp.agent, from: sp.from, to: sp.to })) if (v) params.set(k, v);
  const here = `/activity${params.toString() ? "?" + params.toString() : ""}`;
  const older = feed.rows.length ? `/activity?${new URLSearchParams({ ...Object.fromEntries(params), before: String(feed.rows[feed.rows.length - 1].e.seq) }).toString()}` : null;
  const filtering = params.toString().length > 0;
  const canNote = ctx.role !== "viewer";

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Activity</div>
          <h1>What happened, in order</h1>
          <p className="muted">Every event in {ctx.workspaceName}, read as sentences: who asked, what was allowed, what was captured, who approved. Filter it, search it, leave a note on anything. The <Link href="/ledger">ledger</Link> is the same record with hashes.</p>
        </div>
      </div>

      {sp.error && <div className="notice bad" style={{ marginBottom: 16 }}>{sp.error}</div>}

      <form method="get" action="/activity" className="card form" style={{ marginBottom: 20 }}>
        <div className="row-3">
          <div className="field"><label htmlFor="q">Search</label><input id="q" name="q" defaultValue={sp.q ?? ""} placeholder="merchant, purpose, email, id…" /></div>
          <div className="field"><label htmlFor="group">Kind</label>
            <select id="group" name="group" defaultValue={group}><option value="">Everything</option>{GROUPS.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}</select></div>
          <div className="field"><label htmlFor="outcome">Outcome</label>
            <select id="outcome" name="outcome" defaultValue={outcome}><option value="">Any</option>{OUTCOMES.map((o) => <option key={o} value={o}>{o}</option>)}</select></div>
        </div>
        <div className="row-3">
          <div className="field"><label htmlFor="agent">Agent</label>
            <select id="agent" name="agent" defaultValue={isId(sp.agent) ? sp.agent : ""}><option value="">Any agent</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
          <div className="field"><label htmlFor="mandate">Mandate</label>
            <select id="mandate" name="mandate" defaultValue={isId(sp.mandate) ? sp.mandate : ""}><option value="">Any mandate</option>{mandates.map(({ m, agentName }) => <option key={m.id} value={m.id}>{m.name} · {agentName}</option>)}</select></div>
          <div className="field"><label>Between</label><div className="row" style={{ gap: 6 }}><input name="from" type="date" defaultValue={sp.from ?? ""} aria-label="From" /><input name="to" type="date" defaultValue={sp.to ?? ""} aria-label="To" /></div></div>
        </div>
        <div className="actions"><button className="btn secondary sm" type="submit">Filter</button>{filtering && <Link className="btn secondary sm" href="/activity">Clear</Link>}</div>
      </form>

      <div className="stack" style={{ gap: 8 }}>
        {feed.rows.length === 0 && <div className="card empty">Nothing here{filtering ? " for these filters" : " yet"}.</div>}
        {feed.rows.map(({ e, d, payload, notes }) => {
          const tid = typeof payload.transactionId === "string" ? payload.transactionId : null;
          const aid = typeof payload.approvalId === "string" ? payload.approvalId : null;
          const target = tid ? { type: "transaction", id: tid } : aid ? { type: "approval", id: aid } : { type: "event", id: e.id };
          return (
            <article key={e.id} className="card" style={{ padding: "12px 16px", borderLeft: `3px solid ${d.tone === "ok" ? "var(--ok)" : d.tone === "bad" ? "var(--bad)" : d.tone === "warn" ? "var(--warn)" : "var(--rule)"}` }}>
              <div style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
                <span className="faint mono" style={{ fontSize: 11.5, minWidth: 34 }}>#{e.seq}</span>
                <span style={{ flex: 1, minWidth: 240 }}>{d.summary}</span>
                {d.outcome && <Pill v={d.outcome} />}
                <span className="faint" style={{ fontSize: 12.5, whiteSpace: "nowrap" }}><When d={e.createdAt} /></span>
              </div>
              <div className="faint" style={{ fontSize: 12, marginTop: 4, display: "flex", gap: 10, flexWrap: "wrap" }}>
                <span className="mono">{e.type}</span>
                {d.mandateId && <Link href={`/mandates/${d.mandateId}`}>mandate</Link>}
                {d.mandateId && <Link href={`/activity?mandate=${d.mandateId}`}>all on this mandate</Link>}
                {d.agentId && <Link href={`/activity?agent=${d.agentId}`}>all by this agent</Link>}
                {d.amount != null && d.currency && <span className="num">{fmt(d.amount, d.currency)}</span>}
                <details style={{ display: "inline" }}><summary style={{ cursor: "pointer", display: "inline" }}>payload</summary><pre style={{ fontSize: 11, marginTop: 6, maxWidth: "100%", overflowX: "auto" }}>{JSON.stringify(payload, null, 2)}</pre></details>
              </div>
              {(notes.length > 0 || canNote) && (
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px dashed var(--rule)" }}>
                  {notes.map((n) => (
                    <div key={n.id} style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "baseline" }}>
                      <span style={{ flex: 1 }}>{n.body} <span className="faint" style={{ fontSize: 11.5 }}>— {n.authorEmail}, <When d={n.createdAt} /></span></span>
                      {n.authorId === ctx.userId && <form action={removeNoteAction}><input type="hidden" name="id" value={n.id} /><input type="hidden" name="back" value={here} /><button className="btn secondary sm" type="submit" style={{ padding: "0 6px" }} title="Remove note">×</button></form>}
                    </div>
                  ))}
                  {canNote && (
                    <form action={addNoteAction} style={{ display: "flex", gap: 6, marginTop: notes.length ? 6 : 0 }}>
                      <input type="hidden" name="targetType" value={target.type} /><input type="hidden" name="targetId" value={target.id} /><input type="hidden" name="back" value={here} />
                      <input name="body" placeholder="Add a note…" maxLength={1000} aria-label="Note" style={{ flex: 1, fontSize: 13, padding: "4px 8px" }} />
                      <button className="btn secondary sm" type="submit">Note</button>
                    </form>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
      {feed.more && older && <div className="actions" style={{ marginTop: 16 }}><Link className="btn secondary" href={older}>Older</Link></div>}
    </>
  );
}
