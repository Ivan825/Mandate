import Link from "next/link";
import { requireCtx, can } from "@/lib/session";
import { listApprovals } from "@/lib/service";
import { fmt } from "@/lib/policy";
import { Pill, When } from "@/app/components";
import { decideApprovalAction } from "@/app/actions";

export default async function ApprovalsPage() {
  const ctx = await requireCtx();
  const [all, mayDecide] = await Promise.all([listApprovals(ctx.workspaceId), can({ approval: ["decide"] })]);
  const pending = all.filter((r) => r.a.status === "pending");
  const history = all.filter((r) => r.a.status !== "pending").slice(0, 30);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Approval inbox</div>
          <h1>{pending.length === 0 ? "Nothing waiting on you" : `${pending.length} request${pending.length === 1 ? "" : "s"} waiting on you`}</h1>
          <p className="muted">An agent asked to spend above its threshold. Approving grants a one-time allowance for that exact amount at that merchant, valid 24 hours; the agent retries and the purchase goes through. Denying blocks the same ask for 6 hours.</p>
        </div>
      </div>

      <div className="stack" style={{ marginBottom: 36 }}>
        {pending.map(({ a, agentName, mandateName }) => (
          <div className="card approval" key={a.id}>
            <div>
              <div className="amt num">{fmt(a.amount, a.currency)} <span className="muted" style={{ fontFamily: "var(--sans)", fontSize: 15, fontWeight: 400 }}>at {a.merchant}</span></div>
              <div className="meta"><strong>{agentName}</strong> · <Link href={`/mandates/${a.mandateId}`}>{mandateName}</Link> · asked <When d={a.requestedAt} /></div>
              {a.purpose && <div className="meta">“{a.purpose}”</div>}
            </div>
            {mayDecide ? (
              <form action={decideApprovalAction} className="actions">
                <input type="hidden" name="approvalId" value={a.id} />
                <button className="btn ok" name="decision" value="approve" type="submit">Approve once</button>
                <button className="btn danger" name="decision" value="deny" type="submit">Deny</button>
              </form>
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
              <tr key={a.id}><td><When d={a.requestedAt} /></td><td>{agentName}</td><td>{a.merchant}</td><td className="r num">{fmt(a.amount, a.currency)}</td><td><Pill v={a.status} /></td><td><When d={a.decidedAt} /></td><td className="faint" style={{ fontSize: 12.5 }}>{a.decidedBy ?? ""}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
