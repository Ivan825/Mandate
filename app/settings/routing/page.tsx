import Link from "next/link";
import { eq } from "drizzle-orm";
import { requireCtx, can } from "@/lib/session";
import { db, schema } from "@/lib/db";
import { listRoutes, parseUserIds } from "@/lib/routing";
import { listMandates, getWorkspaceSettings } from "@/lib/service";
import { fmt } from "@/lib/money";
import { inputStep } from "@/lib/money";
import { Pill, When } from "@/app/components";
import { addRouteAction, removeRouteAction, toggleRouteAction } from "@/app/actions";

export const metadata = { title: "Approval routing" };

export default async function RoutingPage({ searchParams }: { searchParams: Promise<{ added?: string; error?: string }> }) {
  const ctx = await requireCtx();
  const { added, error } = await searchParams;
  const manage = await can({ workspace: ["settings"] });
  const [routes, mandates, settings, members] = await Promise.all([
    listRoutes(ctx.workspaceId), listMandates(ctx.workspaceId, true), getWorkspaceSettings(ctx.workspaceId),
    db.select({ userId: schema.member.userId, role: schema.member.role, email: schema.user.email, name: schema.user.name }).from(schema.member).innerJoin(schema.user, eq(schema.user.id, schema.member.userId)).where(eq(schema.member.organizationId, ctx.workspaceId)),
  ]);
  const deciders = members.filter((m) => /\b(owner|admin|approver)\b/.test(m.role));
  const who = (id: string) => { const m = members.find((x) => x.userId === id); return m ? m.name || m.email : "former member"; };
  const ccy = settings.currency;

  return (
    <div style={{ maxWidth: 860 }}>
      <div className="eyebrow"><Link href="/settings">Settings</Link> · Approval routing</div>
      <h1>Who is asked about what</h1>
      <p className="muted" style={{ margin: "8px 0 20px" }}>Without routes, every owner, admin and approver is notified of every request (fine for a household). A team adds routes: “above {fmt(50000, ccy)} → finance”, “category travel → ops”, “this mandate → its sponsor”. The first enabled route whose conditions all match decides who is notified and whose inbox shows the request as theirs; anyone who may decide can still decide. No match → everyone, as before.</p>
      {error && <div className="notice bad" style={{ marginBottom: 12 }}>{error}</div>}
      {added && <div className="notice ok" style={{ marginBottom: 12 }}>Route added.</div>}

      <h2 style={{ marginBottom: 8 }}>Routes <span className="faint" style={{ fontWeight: 400, fontSize: 13 }}>checked in this order</span></h2>
      <div className="tbl" style={{ marginBottom: 20 }}>
        <table>
          <thead><tr><th className="r">#</th><th>Route</th><th>Matches</th><th>Goes to</th><th>Status</th><th>Added</th><th></th></tr></thead>
          <tbody>
            {routes.length === 0 && <tr><td colSpan={7} className="empty">No routes: every decider is asked about everything.</td></tr>}
            {routes.map((r) => (
              <tr key={r.id}>
                <td className="r num">{r.priority}</td>
                <td><strong>{r.name}</strong></td>
                <td style={{ fontSize: 13 }}>
                  {r.minAmount == null && r.maxAmount == null && !r.category && !r.merchantPattern && !r.mandateId ? <span className="faint">every request</span> : null}
                  {(r.minAmount != null || r.maxAmount != null) && <div>amount {r.minAmount != null ? `≥ ${fmt(r.minAmount, ccy)}` : ""}{r.minAmount != null && r.maxAmount != null ? " and " : ""}{r.maxAmount != null ? `≤ ${fmt(r.maxAmount, ccy)}` : ""}</div>}
                  {r.category && <div>category <span className="mono">{r.category}</span></div>}
                  {r.merchantPattern && <div>merchant <span className="mono">{r.merchantPattern}</span></div>}
                  {r.mandateId && <div>mandate {mandates.find((m) => m.m.id === r.mandateId)?.m.name ?? <span className="faint">(gone)</span>}</div>}
                </td>
                <td style={{ fontSize: 13 }}>{parseUserIds(r.userIds).map(who).join(", ")}</td>
                <td><Pill v={r.enabled ? "active" : "paused"} /></td>
                <td><When d={r.createdAt} /><div className="faint" style={{ fontSize: 11.5 }}>{r.createdBy}</div></td>
                <td>{manage && <div className="actions" style={{ gap: 4 }}>
                  <form action={toggleRouteAction}><input type="hidden" name="id" value={r.id} /><input type="hidden" name="enabled" value={r.enabled ? "0" : "1"} /><button className="btn secondary sm" type="submit">{r.enabled ? "Disable" : "Enable"}</button></form>
                  <form action={removeRouteAction}><input type="hidden" name="id" value={r.id} /><button className="btn danger sm" type="submit">Remove</button></form>
                </div>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {manage ? (
        <form action={addRouteAction} className="card form" style={{ marginBottom: 28 }}>
          <div className="eyebrow">Add a route</div>
          <input type="hidden" name="currency" value={ccy} />
          <div className="row">
            <div className="field"><label htmlFor="name">Name</label><input id="name" name="name" required placeholder="Big spends → finance" /></div>
            <div className="field"><label htmlFor="priority">Order (lower first)</label><input id="priority" name="priority" type="number" min="0" max="1000" step="1" defaultValue="100" /></div>
          </div>
          <div className="row-3">
            <div className="field"><label htmlFor="minAmount">Amount at least ({ccy})</label><input id="minAmount" name="minAmount" type="number" min="0" step={inputStep(ccy)} placeholder="any" /></div>
            <div className="field"><label htmlFor="maxAmount">Amount at most ({ccy})</label><input id="maxAmount" name="maxAmount" type="number" min="0" step={inputStep(ccy)} placeholder="any" /></div>
            <div className="field"><label htmlFor="category">Category</label><input id="category" name="category" placeholder="any" /></div>
          </div>
          <div className="row">
            <div className="field"><label htmlFor="merchantPattern">Merchant (trailing * = prefix)</label><input id="merchantPattern" name="merchantPattern" placeholder="any" /></div>
            <div className="field"><label htmlFor="mandateId">Mandate</label><select id="mandateId" name="mandateId" defaultValue=""><option value="">any</option>{mandates.map((m) => <option key={m.m.id} value={m.m.id}>{m.m.name} · {m.agentName}</option>)}</select></div>
          </div>
          <div className="field">
            <label>Route to</label>
            <div className="stack" style={{ gap: 4 }}>{deciders.map((m) => <label key={m.userId} className="check"><input type="checkbox" name="userIds" value={m.userId} /> {m.name || m.email} <span className="faint">({m.role.split(",")[0]})</span></label>)}</div>
            <span className="hint">Only owners, admins and approvers can be routed to. Amounts are in the workspace's default currency; requests in other currencies match on their own minor units.</span>
          </div>
          <div className="actions"><button className="btn secondary" type="submit">Add route</button></div>
        </form>
      ) : <p className="faint">Only owners and admins manage routing.</p>}
    </div>
  );
}
