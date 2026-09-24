import Link from "next/link";
import { requireCtx, can } from "@/lib/session";
import { listApprovals, listPlans, planView } from "@/lib/service";
import { fmt } from "@/lib/policy";
import { Pill, When, Flags } from "@/app/components";
import { decideApprovalAction, decidePlanAction } from "@/app/actions";
import { SignedDecision } from "./sign";

export default async function ApprovalsPage() {
  const ctx = await requireCtx();
  const [all, plans, mayDecide] = await Promise.all([listApprovals(ctx.workspaceId), listPlans(ctx.workspaceId, { status: "proposed" }), can({ approval: ["decide"] })]);
  const pending = all.filter((r) => r.a.status === "pending");
  const asks = pending.filter((r) => r.a.kind !== "veto");
  const vetoes = pending.filter((r) => r.a.kind === "veto");
  const history = all.filter((r) => r.a.status !== "pending").slice(0, 30);
  const waiting = asks.length + vetoes.length + plans.length;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Approval inbox</div>
          <h1>{waiting === 0 ? "Nothing waiting on you" : `${waiting} thing${waiting === 1 ? "" : "s"} waiting on you`}</h1>
          <p className="muted">Requests above an agent's threshold, plans it wants approved up front, and purchases in a veto window that go through unless you cancel. Approving a request grants a one-time allowance for that exact amount at that merchant, valid 24 hours; denying blocks the same ask for 6 hours.</p>
        </div>
      </div>

      {vetoes.length > 0 && (
        <>
          <h2 style={{ marginBottom: 8 }}>Going through unless you cancel</h2>
          <div className="stack" style={{ marginBottom: 28 }}>
            {vetoes.map(({ a, agentName, mandateName }) => (
              <div className="card approval veto" key={a.id}>
                <div>
                  <div className="amt num">{fmt(a.amount, a.currency)} <span className="muted" style={{ fontFamily: "var(--sans)", fontSize: 15, fontWeight: 400 }}>at {a.merchant}</span></div>
                  <div className="meta"><strong>{agentName}</strong> · <Link href={`/mandates/${a.mandateId}`}>{mandateName}</Link> · executes <When d={a.vetoUntil} /> unless cancelled</div>
                  {a.purpose && <div className="meta">“{a.purpose}”</div>}
                  <Flags json={a.flags} />
                </div>
                {mayDecide ? (
                  <form action={decideApprovalAction} className="actions">
                    <input type="hidden" name="approvalId" value={a.id} />
                    <button className="btn danger" name="decision" value="deny" type="submit">Cancel it</button>
                    <button className="btn secondary" name="decision" value="approve" type="submit">Let it through now</button>
                  </form>
                ) : <span className="faint">Waiting for an approver</span>}
              </div>
            ))}
          </div>
        </>
      )}

      {plans.length > 0 && (
        <>
          <h2 style={{ marginBottom: 8 }}>Plans to approve</h2>
          <div className="stack" style={{ marginBottom: 28 }}>
            {plans.map(({ p, agentName, mandateName }) => { const v = planView(p); return (
              <div className="card approval" key={p.id} style={{ alignItems: "flex-start" }}>
                <div style={{ flex: 1 }}>
                  <div className="amt num" style={{ fontSize: 18 }}>{v.title} <span className="muted" style={{ fontFamily: "var(--sans)", fontSize: 14, fontWeight: 400 }}>· {v.items.length} item{v.items.length === 1 ? "" : "s"}, up to {fmt(v.totalMax, v.currency)}</span></div>
                  <div className="meta"><strong>{agentName}</strong> · <Link href={`/mandates/${p.mandateId}`}>{mandateName}</Link> · proposed <When d={p.createdAt} /></div>
                  <table className="mini" style={{ marginTop: 6 }}><tbody>{v.items.map((it) => <tr key={it.index}><td>{it.merchant}{it.purpose && <span className="faint"> — {it.purpose}</span>}</td><td className="r num">up to {fmt(it.amount, v.currency)}</td></tr>)}</tbody></table>
                  <div className="faint" style={{ fontSize: 12.5, marginTop: 6 }}>Approving lets each item through once without asking, for 7 days. Anything outside the list still asks.</div>
                </div>
                {mayDecide ? (
                  <form action={decidePlanAction} className="actions">
                    <input type="hidden" name="planId" value={p.id} />
                    <button className="btn ok" name="decision" value="approve" type="submit">Approve plan</button>
                    <button className="btn danger" name="decision" value="deny" type="submit">Deny</button>
                  </form>
                ) : <span className="faint">Waiting for an approver</span>}
              </div>
            ); })}
          </div>
        </>
      )}

      {(asks.length > 0 || waiting === 0) && <h2 style={{ marginBottom: 8 }}>Requests</h2>}
      <div className="stack" style={{ marginBottom: 36 }}>
        {asks.map(({ a, agentName, mandateName }) => (
          <div className="card approval" key={a.id}>
            <div>
              <div className="amt num">{fmt(a.amount, a.currency)} <span className="muted" style={{ fontFamily: "var(--sans)", fontSize: 15, fontWeight: 400 }}>at {a.merchant}</span></div>
              <div className="meta"><strong>{agentName}</strong> · <Link href={`/mandates/${a.mandateId}`}>{mandateName}</Link> · asked <When d={a.requestedAt} /></div>
              {a.purpose && <div className="meta">“{a.purpose}”</div>}
              <Flags json={a.flags} />
            </div>
            {mayDecide ? (
              <div className="actions" style={{ alignItems: "flex-start" }}>
                <SignedDecision approvalId={a.id} decision="approve" label="Approve once · signed" className="btn ok" />
                <form action={decideApprovalAction} className="actions">
                  <input type="hidden" name="approvalId" value={a.id} />
                  <button className="btn secondary" name="decision" value="approve" type="submit" title="Approve without a passkey signature">Approve once</button>
                  <button className="btn danger" name="decision" value="deny" type="submit">Deny</button>
                </form>
              </div>
            ) : <span className="faint">Waiting for an approver</span>}
          </div>
        ))}
      </div>

      <h2 style={{ marginBottom: 10 }}>Decided</h2>
      <div className="tbl">
        <table>
          <thead><tr><th>Requested</th><th>Agent</th><th>Merchant</th><th className="r">Amount</th><th>Outcome</th><th>Decided</th><th>By</th></tr></thead>
          <tbody>
            {history.length === 0 && <tr><td colSpan={7} className="empty">No decisions yet.</td></tr>}
            {history.map(({ a, agentName }) => (
              <tr key={a.id}><td><When d={a.requestedAt} /></td><td>{agentName}</td><td>{a.merchant}{a.kind === "veto" && <span className="faint"> · veto</span>}</td><td className="r num">{fmt(a.amount, a.currency)}</td><td><Pill v={a.status} /></td><td><When d={a.decidedAt} /></td><td className="faint" style={{ fontSize: 12.5 }}>{a.decidedBy === "silence" ? "no objection" : a.decidedBy ?? ""}{a.signedWith && <span className="pill ok" style={{ marginLeft: 6 }} title={`Passkey ${a.signedWith.slice(0, 8)}…`}>signed</span>}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
