import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCtx, can } from "@/lib/session";
import { getMandate, factsFor, recentTransactions, listApprovals, revealToken } from "@/lib/service";
import { db, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { fmt, parseList } from "@/lib/policy";
import { stripeEnabled } from "@/lib/stripe";
import { Pill, Util, When } from "@/app/components";
import { simulatePurchaseAction, revokeMandateAction, freezeCardAction } from "@/app/actions";
import { stripePublishableKey } from "@/lib/stripe";
import { availableBalance } from "@/lib/balance";
import { CardReveal } from "./card";
import { grantValid, sweepReveals } from "@/lib/reveal";
import { appUrl } from "@/lib/env";

export default async function MandatePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ new?: string; g?: string; error?: string }> }) {
  const ctx = await requireCtx();
  const { id } = await params;
  const { new: isNew, g, error: actionError } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const m = await getMandate(ctx.workspaceId, id);
  if (!m) notFound();
  await sweepReveals();
  const revealed = isNew && grantValid(m.id, g) ? await revealToken(ctx.workspaceId, m.id) : null;
  const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.id, m.agentId)).limit(1);
  const [facts, txns, approvals] = await Promise.all([factsFor(m), recentTransactions(ctx.workspaceId, 50, m.id), listApprovals(ctx.workspaceId)]);
  const mine = approvals.filter((a) => a.a.mandateId === m.id);
  const allowed = parseList(m.allowedMerchants);
  const blocked = parseList(m.blockedCategories);
  const base = appUrl();
  const expired = m.status === "active" && m.expiresAt && new Date() > new Date(m.expiresAt);
  const status = expired ? "expired" : m.status;
  const liveAllowances = facts.approvedAllowances.filter((a) => !a.expiresAt || new Date() <= new Date(a.expiresAt)).length;
  const [mayRevoke, mayTry, mayIssue] = await Promise.all([can({ mandate: ["revoke"] }), can({ mandate: ["try"] }), can({ mandate: ["issue"] })]);
  const pk = stripePublishableKey();
  const balance = m.stripeCardId ? await availableBalance(ctx.workspaceId, m.currency) : null;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{agent?.name ?? "Agent"} · mandate</div>
          <h1>{m.name} <Pill v={status} /></h1>
          <p className="muted">{m.currency} · issued <When d={m.createdAt} />{m.expiresAt && <> · valid to end of {new Date(m.expiresAt).toLocaleDateString("en-GB", { timeZone: m.timezone, day: "2-digit", month: "short", year: "numeric" })} ({m.timezone})</>}{m.revokedAt && <> · revoked <When d={m.revokedAt} /></>}</p>
        </div>
        <div className="actions">
          <Link className="btn secondary" href={`/mandates/${m.id}/receipt`}>Receipt</Link>
          {m.status === "active" && mayRevoke && (
            <form action={revokeMandateAction}><input type="hidden" name="mandateId" value={m.id} /><button className="btn danger" type="submit">Revoke now</button></form>
          )}
        </div>
      </div>

      {revealed && (
        <div className="notice" style={{ marginBottom: 20 }}>
          <strong>Mandate issued. Copy the agent token now — it is shown only this once.</strong>
          <div className="token" style={{ margin: "10px 0 6px" }}>{revealed}</div>
          Use it for agents you run yourself (REST API or the local MCP server). Agents connected through OAuth (Claude, ChatGPT, Cursor) don't need it — they see this mandate automatically. Revoking the mandate cuts both off instantly.
        </div>
      )}
      {isNew && !revealed && (
        <div className="notice" style={{ marginBottom: 20 }}>The token for this mandate was already shown once and is not stored. If you didn't copy it, revoke this mandate and issue a new one.</div>
      )}
      {m.cardError && (
        <div className="notice bad" style={{ marginBottom: 20 }}><strong>Card not issued.</strong> {m.cardError} The mandate works through the API and MCP; fix this in <Link href="/settings">Settings</Link> and issue a new mandate for a card.</div>
      )}
      {actionError && <div className="notice bad" style={{ marginBottom: 20 }}>{actionError}</div>}
      {m.stripeCardId && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="page-head" style={{ marginBottom: 10 }}>
            <div>
              <div className="eyebrow">Virtual card</div>
              <h3 style={{ marginTop: 4 }}>Stripe virtual card ···{m.cardLast4} <Pill v={m.cardStatus === "inactive" ? "frozen" : m.cardStatus ?? "active"} /></h3>
              <p className="muted" style={{ fontSize: 13.5, margin: "4px 0 0" }}>Every swipe is decided in real time by this mandate and paid from the workspace's prepaid balance ({fmt(balance ?? 0, m.currency)} available). {mayRevoke && m.cardStatus !== "canceled" && "Freeze it to pause the agent without revoking the mandate."}</p>
            </div>
            {mayRevoke && m.status === "active" && m.cardStatus !== "canceled" && (
              <form action={freezeCardAction}><input type="hidden" name="mandateId" value={m.id} /><input type="hidden" name="frozen" value={m.cardStatus === "inactive" ? "0" : "1"} /><button className="btn secondary sm" type="submit">{m.cardStatus === "inactive" ? "Unfreeze card" : "Freeze card"}</button></form>
            )}
          </div>
          {mayIssue && pk && m.cardStatus !== "canceled" ? <CardReveal mandateId={m.id} cardId={m.stripeCardId} publishableKey={pk} last4={m.cardLast4 ?? ""} exp={m.cardExp} /> : <span className="mono">···· {m.cardLast4}{m.cardExp ? ` · ${m.cardExp}` : ""}</span>}
        </div>
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
            <dt>Card</dt><dd>{m.cardLast4 ? <span className="mono">Stripe virtual ···{m.cardLast4}{m.cardStatus && m.cardStatus !== "active" ? ` (${m.cardStatus === "inactive" ? "frozen" : m.cardStatus})` : ""}</span> : <span className="faint">none (API and MCP only)</span>}</dd>
            <dt>Token</dt><dd><span className="mono">{m.tokenPrefix}…</span> <span className="faint">(stored hashed; shown once at issue)</span></dd>
          </dl>
          <div className="faint" style={{ fontSize: 12.5 }}>Own agents call <code>POST {base}/api/agent/authorize</code> with the token; connected agents use the <code>request_purchase</code> tool. <Link href="/docs">Connect agents</Link>.</div>
        </div>

        <div className="card">
          <div className="eyebrow" style={{ marginBottom: 6 }}>Try it as the agent</div>
          <p className="faint" style={{ fontSize: 12.5, marginBottom: 12 }}>This goes through the same decision path as a real request and counts against the mandate — use it to see how the terms behave.</p>
          {status !== "active" ? (
            <p className="muted">This mandate is {status}; attempts will be declined.</p>
          ) : !mayTry ? (
            <p className="muted">Your role ({ctx.role}) can watch this mandate but not spend under it.</p>
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
                <td className="mono faint">{t.source}{t.actor && <div style={{ fontSize: 11 }}>{t.actor.slice(0, 22)}</div>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
