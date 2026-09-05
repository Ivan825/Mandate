import Link from "next/link";
import { notFound } from "next/navigation";
import { getMandate, factsFor, recentTransactions, listApprovals, takeTokenReveal } from "@/lib/service";
import { db, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { fmt, parseList } from "@/lib/policy";
import { stripeEnabled } from "@/lib/stripe";
import { Pill, Util, When } from "@/app/components";
import { simulatePurchaseAction, revokeMandateAction } from "@/app/actions";

export default async function MandatePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ new?: string }> }) {
  const { id } = await params;
  const { new: isNew } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const m = await getMandate(id);
  if (!m) notFound();
  const revealed = isNew ? await takeTokenReveal(m.id) : null;
  const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.id, m.agentId)).limit(1);
  const [facts, txns, approvals] = await Promise.all([factsFor(m), recentTransactions(50, m.id), listApprovals()]);
  const mine = approvals.filter((a) => a.a.mandateId === m.id);
  const allowed = parseList(m.allowedMerchants);
  const blocked = parseList(m.blockedCategories);
  const base = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
  const expired = m.status === "active" && m.expiresAt && new Date() > new Date(m.expiresAt);
  const status = expired ? "expired" : m.status;
  const liveAllowances = facts.approvedAllowances.filter((a) => !a.expiresAt || new Date() <= new Date(a.expiresAt)).length;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{agent?.name ?? "Agent"} · mandate</div>
          <h1>{m.name} <Pill v={status} /></h1>
          <p className="muted">{m.currency} · issued <When d={m.createdAt} />{m.expiresAt && <> · valid to end of {new Date(m.expiresAt).toLocaleDateString("en-GB", { timeZone: m.timezone, day: "2-digit", month: "short", year: "numeric" })} ({m.timezone})</>}{m.revokedAt && <> · revoked <When d={m.revokedAt} /></>}</p>
        </div>
        <div className="actions">
          <a className="btn secondary" href={`/api/ledger/export?mandate=${m.id}`}>Download receipt</a>
          {m.status === "active" && (
            <form action={revokeMandateAction}><input type="hidden" name="mandateId" value={m.id} /><button className="btn danger" type="submit">Revoke now</button></form>
          )}
        </div>
      </div>

      {revealed && (
        <div className="notice" style={{ marginBottom: 20 }}>
          <strong>Mandate issued. Copy the agent token now — it is shown only this once.</strong>
          <div className="token" style={{ margin: "10px 0 6px" }}>{revealed}</div>
          It is the only credential the agent holds; the card and your accounts stay with you. Revoking the mandate kills it instantly. If you lose it, revoke and issue a new mandate.
        </div>
      )}
      {isNew && !revealed && (
        <div className="notice" style={{ marginBottom: 20 }}>The token for this mandate was already shown once and is not stored. If you didn't copy it, revoke this mandate and issue a new one.</div>
      )}
      {m.cardError && (
        <div className="notice bad" style={{ marginBottom: 20 }}><strong>Card not issued.</strong> Stripe said: {m.cardError}. The mandate works through the agent API; fix the Stripe setup and issue a new mandate for a card.</div>
      )}

      <div className="grid-3" style={{ marginBottom: 20 }}>
        <div className="card"><Util used={facts.spentToday} limit={m.dailyLimit} currency={m.currency} label="today" /></div>
        <div className="card"><Util used={facts.spentTotal} limit={m.totalLimit} currency={m.currency} label="lifetime" /></div>
        <div className="card">
          <div className="eyebrow">Escalation</div>
          <div style={{ fontFamily: "var(--serif)", fontSize: 22, fontWeight: 600 }} className="num">{m.approvalAbove == null ? "never asks" : `asks above ${fmt(m.approvalAbove, m.currency)}`}</div>
          <div className="faint" style={{ fontSize: 12.5 }}>{facts.openPending} waiting on you · {liveAllowances} approval{liveAllowances === 1 ? "" : "s"} granted and unused</div>
        </div>
      </div>

      <div className="grid-2" style={{ marginBottom: 28 }}>
        <div className="card stack">
          <div className="eyebrow">Terms</div>
          <dl className="dl">
            <dt>Per transaction</dt><dd className="num">{fmt(m.perTxnLimit, m.currency)}</dd>
            <dt>Per day</dt><dd className="num">{fmt(m.dailyLimit, m.currency)}</dd>
            <dt>Total sanctioned</dt><dd className="num">{fmt(m.totalLimit, m.currency)}</dd>
            <dt>Merchants</dt><dd>{allowed.length ? allowed.join(", ") : <span className="faint">any</span>}</dd>
            <dt>Blocked</dt><dd>{blocked.length ? blocked.join(", ") : <span className="faint">none</span>}</dd>
            <dt>Active hours</dt><dd className="num">{m.activeHoursStart === 0 && m.activeHoursEnd === 24 ? "all day" : `${String(m.activeHoursStart).padStart(2, "0")}:00–${String(m.activeHoursEnd).padStart(2, "0")}:00`} {m.timezone}</dd>
            <dt>Card</dt><dd>{m.cardLast4 ? <span className="mono">Stripe virtual ···{m.cardLast4}</span> : <span className="faint">none (API only)</span>}</dd>
            <dt>Token</dt><dd><span className="mono">{m.tokenPrefix}…</span> <span className="faint">(stored hashed; shown once at issue)</span></dd>
          </dl>
          <div className="faint" style={{ fontSize: 12.5 }}>Agents call <code>POST {base}/api/agent/authorize</code> with the token as a Bearer token. <Link href="/docs">See the API</Link>.</div>
        </div>

        <div className="card">
          <div className="eyebrow" style={{ marginBottom: 6 }}>Try it as the agent</div>
          <p className="faint" style={{ fontSize: 12.5, marginBottom: 12 }}>This goes through the same decision path as a real request and counts against the mandate — use it to see how the terms behave.</p>
          {status !== "active" ? (
            <p className="muted">This mandate is {status}; attempts will be declined.</p>
          ) : (
            <form action={simulatePurchaseAction} className="form">
              <input type="hidden" name="mandateId" value={m.id} />
              <div className="row">
                <div className="field"><label htmlFor="amount">Amount ({m.currency})</label><input id="amount" name="amount" type="number" step="0.01" min="0.01" required defaultValue="12.99" /></div>
                <div className="field"><label htmlFor="merchant">Merchant</label><input id="merchant" name="merchant" required defaultValue={allowed[0]?.replace(/\*$/, "") || "OpenAI"} /></div>
              </div>
              <div className="row">
                <div className="field"><label htmlFor="purpose">Purpose (what the agent says)</label><input id="purpose" name="purpose" defaultValue="API credits for the scraper" /></div>
                <div className="field"><label htmlFor="category">Category</label><input id="category" name="category" placeholder="computer_software_stores" /></div>
              </div>
              {stripeEnabled() && m.stripeCardId && (
                <label className="check"><input type="checkbox" name="viaStripe" /> Send through Stripe test authorisation (exercises the real webhook)</label>
              )}
              <div className="actions"><button className="btn" type="submit">Attempt purchase</button></div>
            </form>
          )}
        </div>
      </div>

      {mine.length > 0 && (
        <>
          <h2 style={{ marginBottom: 10 }}>Approvals on this mandate</h2>
          <div className="tbl" style={{ marginBottom: 28 }}>
            <table>
              <thead><tr><th>Requested</th><th>Merchant</th><th className="r">Amount</th><th>Status</th><th>Decided</th><th>Valid until</th></tr></thead>
              <tbody>
                {mine.map(({ a }) => (
                  <tr key={a.id}><td><When d={a.requestedAt} /></td><td>{a.merchant}{a.purpose && <div className="faint" style={{ fontSize: 12 }}>{a.purpose}</div>}</td><td className="r num">{fmt(a.amount, a.currency)}</td><td><Pill v={a.status} /></td><td><When d={a.decidedAt} /></td><td><When d={a.status === "approved" ? a.expiresAt : null} /></td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2 style={{ marginBottom: 10 }}>Decisions</h2>
      <div className="tbl">
        <table>
          <thead><tr><th>When</th><th>Merchant</th><th className="r">Amount</th><th>Decision</th><th>Reason</th><th>Via</th></tr></thead>
          <tbody>
            {txns.length === 0 && <tr><td colSpan={6} className="empty">No attempts yet.</td></tr>}
            {txns.map(({ t }) => (
              <tr key={t.id}>
                <td><When d={t.createdAt} /></td>
                <td>{t.merchant}{t.purpose && <div className="faint" style={{ fontSize: 12 }}>{t.purpose}</div>}</td>
                <td className="r num">{fmt(t.amount, t.currency)}</td>
                <td><Pill v={t.decision} /></td>
                <td className="muted">{t.reason}</td>
                <td className="mono faint">{t.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
