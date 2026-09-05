import { requireCtx } from "@/lib/session";
import { verifyChain, listEvents } from "@/lib/ledger";
import { When } from "@/app/components";

export default async function LedgerPage() {
  const ctx = await requireCtx();
  const [rows, v] = await Promise.all([listEvents(ctx.workspaceId, 100), verifyChain(ctx.workspaceId)]);
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Ledger</div>
          <h1>Everything that was granted, asked, allowed or refused</h1>
          <p className="muted">Append-only, one chain per workspace. Each row's hash covers the previous row's hash, so an edited or deleted entry breaks verification from that point on. Export it as the receipt in a dispute.</p>
        </div>
        <div className="actions"><a className="btn secondary" href="/api/ledger/export">Export receipt (JSON)</a></div>
      </div>

      <div className={`notice ${v.ok ? "ok" : "bad"}`} style={{ marginBottom: 20 }}>
        {v.ok ? <><strong>Chain intact.</strong> {v.checked} event{v.checked === 1 ? "" : "s"} verified end to end.</> : <><strong>Chain broken at #{v.brokenAt}.</strong> {v.detail}. {v.checked} events before it verify.</>}
      </div>

      <div className="tbl">
        <table>
          <thead><tr><th className="r">#</th><th>When</th><th>Event</th><th>Payload</th><th>Hash</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={5} className="empty">Empty. The first agent you add becomes event #1.</td></tr>}
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="r num mono">{r.seq}</td>
                <td><When d={r.createdAt} /></td>
                <td className="mono">{r.type}</td>
                <td><code style={{ fontSize: 12, wordBreak: "break-all", color: "var(--ink-2)" }}>{r.payload.length > 220 ? r.payload.slice(0, 220) + "…" : r.payload}</code></td>
                <td className="chain"><span title={r.hash}>{r.hash.slice(0, 12)}…</span><br /><span className="h" title={r.prevHash}>← {r.prevHash.slice(0, 12)}…</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
