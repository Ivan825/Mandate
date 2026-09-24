import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCtx, can } from "@/lib/session";
import { getMandate, factsFor, recentTransactions, listApprovals, revealToken } from "@/lib/service";
import { db, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { fmt, parseList } from "@/lib/policy";
import { stripeEnabled } from "@/lib/stripe";
import { Pill, Util, When, Flags } from "@/app/components";
import { simulatePurchaseAction, revokeMandateAction, freezeCardAction, settleHoldAction, pauseMandateAction, resumeMandateAction, raiseLimitAction, withdrawRaiseAction, shareReceiptAction } from "@/app/actions";
import { effectiveTerms, isPaused, OVERRIDE_FIELDS } from "@/lib/policy";
import { listOverrides, shadowReport, listPlans, planView } from "@/lib/service";
import { setModeAction, resetAutonomyAction, cancelPlanAction } from "@/app/actions";
import { WhatIf } from "./whatif";
import { inputStep, toMajor } from "@/lib/money";
import { stripePublishableKey } from "@/lib/stripe";
import { availableBalance } from "@/lib/balance";
import { CardReveal } from "./card";
import { grantValid, sweepReveals } from "@/lib/reveal";
import { appUrl } from "@/lib/env";

export default async function MandatePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ new?: string; g?: string; error?: string; raised?: string }> }) {
  const ctx = await requireCtx();
  const { id } = await params;
  const { new: isNew, g, error: actionError, raised } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const m = await getMandate(ctx.workspaceId, id);
  if (!m) notFound();
  await sweepReveals();
  const revealed = isNew && grantValid(m.id, g) ? await revealToken(ctx.workspaceId, m.id) : null;
  const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.id, m.agentId)).limit(1);
  const [facts, txns, approvals, overrides, shadow, plans] = await Promise.all([factsFor(m), recentTransactions(ctx.workspaceId, 50, m.id), listApprovals(ctx.workspaceId), listOverrides(ctx.workspaceId, m.id), m.mode === "observe" ? shadowReport(ctx.workspaceId, m.id) : null, listPlans(ctx.workspaceId, { mandateId: m.id })]);
  const autonomyMax = m.autonomyStep > 0 ? Math.max(0, (m.autonomyCeiling ?? m.perTxnLimit) - m.perTxnLimit) : 0;
  const now = new Date();
  const eff = effectiveTerms(m, overrides, now);
  const activeRaises = overrides.filter((o) => !o.revokedAt && new Date(o.startsAt) <= now && new Date(o.endsAt) > now);
  const paused = isPaused(m, now);
  const mine = approvals.filter((a) => a.a.mandateId === m.id);
  const allowed = parseList(m.allowedMerchants);
  const blocked = parseList(m.blockedCategories);
  const base = appUrl();
  const expired = (m.status === "active" || m.status === "paused") && m.expiresAt && new Date() > new Date(m.expiresAt);
  const status = expired ? "expired" : paused ? "paused" : m.status === "paused" ? "active" : m.status;
  const liveAllowances = facts.approvedAllowances.filter((a) => !a.expiresAt || new Date() <= new Date(a.expiresAt)).length;
  const [mayRevoke, mayTry, mayIssue, mayShare] = await Promise.all([can({ mandate: ["revoke"] }), can({ mandate: ["try"] }), can({ mandate: ["issue"] }), can({ ledger: ["export"] })]);
  const heldCount = txns.filter(({ t }) => t.settlement === "held").length;
  const pk = stripePublishableKey();
  const balance = m.stripeCardId ? await availableBalance(ctx.workspaceId, m.currency) : null;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{agent?.name ?? "Agent"} · mandate</div>
          <h1>{m.name} <Pill v={status} />{m.mode === "observe" && <> <Pill v="observe" /></>}</h1>
          <p className="muted">{m.currency} · issued <When d={m.createdAt} />{m.expiresAt && <> · valid to end of {new Date(m.expiresAt).toLocaleDateString("en-GB", { timeZone: m.timezone, day: "2-digit", month: "short", year: "numeric" })} ({m.timezone})</>}{m.revokedAt && <> · revoked <When d={m.revokedAt} /></>}</p>
        </div>
        <div className="actions">
          <Link className="btn secondary" href={`/mandates/${m.id}/receipt`}>Receipt</Link>
          <Link className="btn secondary" href={`/mandates/new?from=${m.id}`}>Duplicate</Link>
          {status === "active" && mayRevoke && (
            <details className="menu">
              <summary className="btn secondary">Pause…</summary>
              <form action={pauseMandateAction} className="menu-body form">
                <input type="hidden" name="mandateId" value={m.id} />
                <div className="field"><label htmlFor="pause-hours">For</label>
                  <select id="pause-hours" name="hours" defaultValue="1"><option value="1">1 hour</option><option value="4">4 hours</option><option value="24">24 hours</option><option value="168">a week</option><option value="0">until I resume it</option></select></div>
                <div className="field"><label htmlFor="pause-reason">Why (optional)</label><input id="pause-reason" name="reason" placeholder="looks like a loop" /></div>
                <button className="btn secondary sm" type="submit">Pause</button>
              </form>
            </details>
          )}
          {status === "paused" && mayRevoke && (
            <form action={resumeMandateAction}><input type="hidden" name="mandateId" value={m.id} /><button className="btn ok" type="submit">Resume now</button></form>
          )}
          {(m.status === "active" || m.status === "paused") && !expired && mayRevoke && (
            <form action={revokeMandateAction}><input type="hidden" name="mandateId" value={m.id} /><button className="btn danger" type="submit">Revoke now</button></form>
          )}
        </div>
      </div>

      {revealed && (
        <div className="notice" style={{ marginBottom: 20 }}>
          <strong>Mandate issued. Copy the agent token now — it is shown only this once.</strong>
          <div className="token" style={{ margin: "10px 0 6px" }}>{revealed}</div>
          Use it for agents you run yourself (REST API or the local MCP server). Agents connected through OAuth (Claude, ChatGPT, Cursor) don't need it — they see this mandate automatically. Revoking the mandate cuts both off instantly.
          <div className="actions" style={{ marginTop: 10 }}><Link className="btn secondary sm" href={`/connect?rail=python&mandate=${m.id}&g=${g}`}>Open the connect wizard with this token</Link></div>
        </div>
      )}
      {isNew && !revealed && (
        <div className="notice" style={{ marginBottom: 20 }}>The token for this mandate was already shown once and is not stored. If you didn't copy it, revoke this mandate and issue a new one.</div>
      )}
      {m.cardError && (
        <div className="notice bad" style={{ marginBottom: 20 }}><strong>Card not issued.</strong> {m.cardError} The mandate works through the API and MCP; fix this in <Link href="/settings">Settings</Link> and issue a new mandate for a card.</div>
      )}
      {actionError && <div className="notice bad" style={{ marginBottom: 20 }}>{actionError}</div>}
      {m.mode === "observe" && shadow && (
        <div className="notice" style={{ marginBottom: 20 }}>
          <div className="page-head" style={{ marginBottom: 0 }}>
            <div><strong>Shadow mode: observing, not enforcing.</strong> Every request goes through; the terms' verdict is recorded. So far: {shadow.total} request{shadow.total === 1 ? "" : "s"} seen, <strong>{shadow.wouldDecline}</strong> would have been declined, <strong>{shadow.wouldAsk}</strong> would have asked you{shadow.byRule.length > 0 && <> ({shadow.byRule.map((r) => `${r.rule} ×${r.count}`).join(", ")})</>}.</div>
            {mayIssue && <form action={setModeAction}><input type="hidden" name="mandateId" value={m.id} /><input type="hidden" name="mode" value="enforce" /><button className="btn accent sm" type="submit">Start enforcing</button></form>}
          </div>
          {shadow.rows.length > 0 && <table className="mini" style={{ marginTop: 8 }}><tbody>{shadow.rows.slice(0, 8).map((r) => <tr key={r.id}><td><When d={r.createdAt} /></td><td>{fmt(r.authorizedAmount ?? r.amount, r.currency)} at {r.merchant}</td><td><span className={`pill ${r.shadowDecision}`}>{r.shadowDecision === "pending" ? "would ask" : "would decline"}</span> <span className="faint">{r.shadowReason}</span></td></tr>)}</tbody></table>}
        </div>
      )}
      {raised && <div className="notice ok" style={{ marginBottom: 20 }}>Temporary raise in force. The mandate's own terms are unchanged and come back when it ends.</div>}
      {paused && <div className="notice" style={{ marginBottom: 20 }}><strong>Paused{m.pausedBy ? ` by ${m.pausedBy}` : ""}.</strong> Every request declines with a resume time; the token still works once it resumes{m.pausedUntil ? <> at <When d={m.pausedUntil} /></> : " — press Resume when ready"}.</div>}
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
            <dt>Per transaction</dt><dd className="num">{fmt(m.perTxnLimit, m.currency)}{eff.raised.per_txn && <Raised o={eff.raised.per_txn} ccy={m.currency} />}</dd>
            <dt>Per day</dt><dd className="num">{fmt(m.dailyLimit, m.currency)}{eff.raised.daily && <Raised o={eff.raised.daily} ccy={m.currency} />}</dd>
            <dt>Total sanctioned</dt><dd className="num">{fmt(m.totalLimit, m.currency)}{eff.raised.total && <Raised o={eff.raised.total} ccy={m.currency} />}</dd>
            {eff.raised.approval_above && <><dt>Ask me above</dt><dd className="num">{fmt(m.approvalAbove ?? 0, m.currency)}<Raised o={eff.raised.approval_above} ccy={m.currency} /></dd></>}
            <dt>Merchants</dt><dd>{allowed.length ? allowed.join(", ") : <span className="faint">any</span>}</dd>
            <dt>Blocked</dt><dd>{blocked.length ? blocked.join(", ") : <span className="faint">none</span>}</dd>
            <dt>Active hours</dt><dd className="num">{m.activeHoursStart === 0 && m.activeHoursEnd === 24 ? "all day" : `${String(m.activeHoursStart).padStart(2, "0")}:00–${String(m.activeHoursEnd).padStart(2, "0")}:00`} {m.timezone}</dd>
            {m.vetoAbove != null && <><dt>Veto window</dt><dd>above {fmt(m.vetoAbove, m.currency)}: announced, goes through after {m.vetoMinutes} min unless you cancel</dd></>}
            <dt>Mode</dt><dd>{m.mode === "observe" ? <>observing (nothing declined){mayIssue && <form action={setModeAction} style={{ display: "inline", marginLeft: 8 }}><input type="hidden" name="mandateId" value={m.id} /><input type="hidden" name="mode" value="enforce" /><button className="btn secondary sm" type="submit">enforce</button></form>}</> : <>enforcing{mayIssue && status === "active" && <form action={setModeAction} style={{ display: "inline", marginLeft: 8 }}><input type="hidden" name="mandateId" value={m.id} /><input type="hidden" name="mode" value="observe" /><button className="btn secondary sm" type="submit" title="Let everything through and only record what the terms would have done">observe instead</button></form>}</>}</dd>
            <dt>Holds</dt><dd>{m.holdTtlHours === 0 ? "settle at once" : <>open {m.holdTtlHours} h, then {m.holdPolicy === "release" ? "released" : "captured in full"}</>}{heldCount > 0 && <> · <strong className="num">{heldCount}</strong> open now</>}</dd>
            <dt>Card</dt><dd>{m.cardLast4 ? <span className="mono">Stripe virtual ···{m.cardLast4}{m.cardStatus && m.cardStatus !== "active" ? ` (${m.cardStatus === "inactive" ? "frozen" : m.cardStatus})` : ""}</span> : <span className="faint">none (API and MCP only)</span>}</dd>
            <dt>Token</dt><dd><span className="mono">{m.tokenPrefix}…</span> <span className="faint">(stored hashed; shown once at issue)</span></dd>
          </dl>
          <div className="faint" style={{ fontSize: 12.5 }}>Own agents call <code>POST {base}/api/agent/authorize</code> with the token; connected agents use the <code>request_purchase</code> tool. <Link href="/connect">Connect agents</Link>.</div>
          {mayIssue && status !== "revoked" && !expired && (
            <details className="menu" style={{ marginTop: 6 }}>
              <summary className="btn secondary sm">Raise a limit temporarily…</summary>
              <form action={raiseLimitAction} className="menu-body form">
                <input type="hidden" name="mandateId" value={m.id} />
                <div className="row">
                  <div className="field"><label htmlFor="raise-field">Limit</label><select id="raise-field" name="field" defaultValue="daily">{OVERRIDE_FIELDS.filter((f) => f.key !== "approval_above" || m.approvalAbove != null).map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</select></div>
                  <div className="field"><label htmlFor="raise-amount">New limit ({m.currency})</label><input id="raise-amount" name="amount" type="number" step={inputStep(m.currency)} min={inputStep(m.currency)} required placeholder={String(toMajor(m.dailyLimit * 2, m.currency))} /></div>
                </div>
                <div className="row">
                  <div className="field"><label htmlFor="raise-hours">For</label><select id="raise-hours" name="hours" defaultValue="24"><option value="1">1 hour</option><option value="4">4 hours</option><option value="24">24 hours</option><option value="72">3 days</option><option value="168">a week</option></select></div>
                  <div className="field"><label htmlFor="raise-reason">Why (optional)</label><input id="raise-reason" name="reason" placeholder="launch day" /></div>
                </div>
                <button className="btn secondary sm" type="submit">Raise</button>
                <span className="hint">Only upward, ends on its own, withdrawable any time. The issued terms are never edited.</span>
              </form>
            </details>
          )}
          {activeRaises.length > 0 && (
            <div className="faint" style={{ fontSize: 12.5 }}>Raises in force: {activeRaises.map((o) => (
              <span key={o.id} style={{ display: "inline-flex", gap: 6, alignItems: "center", marginRight: 8 }}>{o.field.replace("_", " ")} → <span className="num">{fmt(o.amount, m.currency)}</span> until <When d={o.endsAt} />{mayIssue && <form action={withdrawRaiseAction} style={{ display: "inline" }}><input type="hidden" name="mandateId" value={m.id} /><input type="hidden" name="overrideId" value={o.id} /><button className="btn secondary sm" type="submit" style={{ padding: "0 6px" }}>withdraw</button></form>}</span>
            ))}</div>
          )}
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
                <div className="field"><label htmlFor="amount">Amount ({m.currency})</label><input id="amount" name="amount" type="number" step={inputStep(m.currency)} min={inputStep(m.currency)} required defaultValue={String(toMajor(Math.min(m.perTxnLimit, Math.max(1, Math.round(m.perTxnLimit / 2))), m.currency))} /></div>
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

      {m.autonomyStep > 0 && (
        <div className="card" style={{ marginBottom: 28 }}>
          <div className="page-head" style={{ marginBottom: 6 }}>
            <div><div className="eyebrow">Trust track (graduated autonomy)</div><p className="muted" style={{ fontSize: 13.5, margin: "4px 0 0" }}>Every {m.autonomyEvery} clean decisions the per-transaction limit and the ask-me-above threshold rise by {fmt(m.autonomyStep, m.currency)}, up to {fmt(m.autonomyCeiling ?? m.perTxnLimit, m.currency)}. A denial or a decline burst steps it back down.</p></div>
            {mayIssue && m.autonomyLevel > 0 && <form action={resetAutonomyAction}><input type="hidden" name="mandateId" value={m.id} /><button className="btn secondary sm" type="submit">Reset to probation</button></form>}
          </div>
          <div className="grid-2">
            <div><div className="faint" style={{ fontSize: 12.5 }}>Earned so far</div><div className="num" style={{ fontFamily: "var(--serif)", fontSize: 22, fontWeight: 600 }}>{fmt(m.autonomyLevel, m.currency)} <span className="faint" style={{ fontSize: 13, fontFamily: "var(--sans)", fontWeight: 400 }}>of {fmt(autonomyMax, m.currency)}</span></div><div className="track"><div style={{ width: `${autonomyMax > 0 ? Math.min(100, Math.round((m.autonomyLevel / autonomyMax) * 100)) : 0}%` }} /></div><div className="faint" style={{ fontSize: 12.5 }}>per transaction now {fmt(eff.perTxnLimit, m.currency)}{eff.approvalAbove != null && <> · asks above {fmt(eff.approvalAbove, m.currency)}</>}</div></div>
            <div><div className="faint" style={{ fontSize: 12.5 }}>Clean streak</div><div className="num" style={{ fontFamily: "var(--serif)", fontSize: 22, fontWeight: 600 }}>{m.autonomyStreak} <span className="faint" style={{ fontSize: 13, fontFamily: "var(--sans)", fontWeight: 400 }}>of {m.autonomyEvery}</span></div><div className="track"><div style={{ width: `${Math.min(100, Math.round((m.autonomyStreak / m.autonomyEvery) * 100))}%`, background: "var(--accent)" }} /></div><div className="faint" style={{ fontSize: 12.5 }}>{m.autonomyLevel >= autonomyMax ? "At the ceiling." : `${Math.max(0, m.autonomyEvery - m.autonomyStreak)} more clean decision${m.autonomyEvery - m.autonomyStreak === 1 ? "" : "s"} to the next step.`}</div></div>
          </div>
        </div>
      )}

      {plans.length > 0 && (
        <>
          <h2 style={{ marginBottom: 10 }}>Plans</h2>
          <div className="tbl" style={{ marginBottom: 28 }}>
            <table>
              <thead><tr><th>Proposed</th><th>Plan</th><th>Items</th><th>Status</th><th>Decided</th><th></th></tr></thead>
              <tbody>
                {plans.map(({ p }) => { const v = planView(p); return (
                  <tr key={p.id}><td><When d={p.createdAt} /></td><td>{v.title}<div className="faint" style={{ fontSize: 12 }}>up to {fmt(v.totalMax, v.currency)}</div></td><td style={{ fontSize: 12.5 }}>{v.items.map((it) => <div key={it.index} style={it.used ? { textDecoration: "line-through", opacity: .6 } : undefined}>{fmt(it.amount, v.currency)} at {it.merchant}</div>)}</td><td><Pill v={p.status} /></td><td><When d={p.decidedAt} />{p.decidedBy && <div className="faint" style={{ fontSize: 11.5 }}>{p.decidedBy}</div>}</td>
                    <td>{(p.status === "proposed" || p.status === "approved") && mayRevoke && <form action={cancelPlanAction}><input type="hidden" name="planId" value={p.id} /><input type="hidden" name="back" value={`/mandates/${m.id}`} /><button className="btn secondary sm" type="submit">Cancel</button></form>}</td></tr>
                ); })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div style={{ marginBottom: 28 }}><WhatIf mandateId={m.id} currency={m.currency} initial={{ perTxnLimit: m.perTxnLimit, dailyLimit: m.dailyLimit, totalLimit: m.totalLimit, approvalAbove: m.approvalAbove, allowedMerchants: allowed }} /></div>

      {mine.length > 0 && (
        <>
          <h2 style={{ marginBottom: 10 }}>Approvals on this mandate</h2>
          <div className="tbl" style={{ marginBottom: 28 }}>
            <table>
              <thead><tr><th>Requested</th><th>Merchant</th><th className="r">Amount</th><th>Status</th><th>Decided</th><th>Valid until</th></tr></thead>
              <tbody>
                {mine.map(({ a }) => (
                  <tr key={a.id}><td><When d={a.requestedAt} /></td><td>{a.merchant}{a.kind === "veto" && <span className="faint"> · veto window</span>}{a.purpose && <div className="faint" style={{ fontSize: 12 }}>{a.purpose}</div>}</td><td className="r num">{fmt(a.amount, a.currency)}</td><td><Pill v={a.status} />{a.signedWith && <span className="pill ok" style={{ marginLeft: 6 }}>signed</span>}</td><td><When d={a.decidedAt} />{a.decidedBy === "silence" && <div className="faint" style={{ fontSize: 11.5 }}>no objection</div>}</td><td><When d={a.status === "approved" ? a.expiresAt : a.status === "pending" && a.vetoUntil ? a.vetoUntil : null} /></td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2 style={{ marginBottom: 10 }}>Decisions</h2>
      <p className="faint" style={{ fontSize: 12.5, margin: "0 0 10px" }}>An approved decision is a hold until the agent captures what it paid or voids it. Amounts shown are what counts against the limits now; a captured row that was authorised for more shows the original struck through.</p>
      <div className="tbl">
        <table>
          <thead><tr><th>When</th><th>Merchant</th><th className="r">Amount</th><th>Decision</th><th>Money</th><th>Reason</th><th>Via</th><th></th></tr></thead>
          <tbody>
            {txns.length === 0 && <tr><td colSpan={8} className="empty">No attempts yet.</td></tr>}
            {txns.map(({ t }) => {
              const authorized = t.authorizedAmount ?? t.amount;
              return (
              <tr key={t.id} id={`tx-${t.id}`}>
                <td><When d={t.createdAt} /></td>
                <td>{t.merchant}{t.purpose && <div className="faint" style={{ fontSize: 12 }}>{t.purpose}</div>}<Flags json={t.flags} small /></td>
                <td className="r num">{t.settlement && t.settlement !== "held" && authorized !== t.amount ? <><s className="faint">{fmt(authorized, t.currency)}</s> {fmt(t.amount, t.currency)}</> : fmt(t.amount, t.currency)}</td>
                <td><Pill v={t.decision} />{t.shadowDecision && t.shadowDecision !== "approved" && <div className="faint" style={{ fontSize: 11.5, marginTop: 4 }} title={t.shadowReason ?? ""}>would {t.shadowDecision === "pending" ? "ask" : "decline"} ({t.shadowRule})</div>}</td>
                <td>
                  {t.settlement && <Pill v={t.settlement} />}
                  {t.settlement === "held" && <div className="faint" style={{ fontSize: 11.5, marginTop: 4 }}>{t.holdExpiresAt ? <>{m.holdPolicy === "release" ? "releases" : "captures"} <When d={t.holdExpiresAt} /></> : "until the card network settles"}</div>}
                  {t.settlement && t.settlement !== "held" && (t.settledBy || t.settlementNote) && <div className="faint" style={{ fontSize: 11.5, marginTop: 4 }}>{t.settledBy && <>by {t.settledBy}</>}{t.settlementNote && <> · {t.settlementNote}</>}</div>}
                  {t.settlement === "held" && mayTry && t.source !== "stripe" && (
                    <details style={{ marginTop: 6 }}>
                      <summary className="faint" style={{ cursor: "pointer", fontSize: 12 }}>Settle it yourself</summary>
                      <form action={settleHoldAction} className="form" style={{ marginTop: 6, gap: 6 }}>
                        <input type="hidden" name="mandateId" value={m.id} /><input type="hidden" name="transactionId" value={t.id} />
                        <div className="row" style={{ gap: 6 }}>
                          <input name="amount" type="number" step={inputStep(t.currency)} min={inputStep(t.currency)} max={toMajor(authorized, t.currency)} placeholder={`paid (max ${toMajor(authorized, t.currency)})`} aria-label="Amount actually paid" style={{ maxWidth: 140 }} />
                          <input name="note" placeholder="note (optional)" aria-label="Note" style={{ maxWidth: 160 }} />
                        </div>
                        <div className="actions" style={{ gap: 6 }}>
                          <button className="btn secondary sm" type="submit" name="kind" value="capture">Capture</button>
                          <button className="btn danger sm" type="submit" name="kind" value="void">Void</button>
                        </div>
                      </form>
                    </details>
                  )}
                </td>
                <td className="muted">{t.reason}</td>
                <td className="mono faint">{t.source}{t.actor && <div style={{ fontSize: 11 }}>{t.actor.slice(0, 22)}</div>}</td>
                <td>
                  {t.shareToken ? (
                    <div className="stack" style={{ gap: 4 }}>
                      <a className="btn secondary sm" href={`/r/${t.id}?k=${t.shareToken}`} target="_blank" rel="noreferrer">Receipt ↗</a>
                      {mayShare && <form action={shareReceiptAction}><input type="hidden" name="transactionId" value={t.id} /><input type="hidden" name="mandateId" value={m.id} /><input type="hidden" name="stop" value="1" /><button className="btn secondary sm" type="submit" title="The public link stops working">Stop sharing</button></form>}
                    </div>
                  ) : mayShare ? (
                    <form action={shareReceiptAction}><input type="hidden" name="transactionId" value={t.id} /><input type="hidden" name="mandateId" value={m.id} /><button className="btn secondary sm" type="submit" title="Create a public, signed, verifiable receipt for this decision">Share receipt</button></form>
                  ) : null}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Raised({ o, ccy }: { o: { amount: number; endsAt: Date }; ccy: string }) {
  return <span className="faint" style={{ fontSize: 12, marginLeft: 6 }}>→ <strong className="num" style={{ color: "var(--warn)" }}>{fmt(o.amount, ccy)}</strong> until <When d={o.endsAt} /></span>;
}
