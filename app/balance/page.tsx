import Link from "next/link";
import { requireCtx, can } from "@/lib/session";
import { balanceSummary, creditTopup, MIN_TOPUP, MAX_TOPUP } from "@/lib/balance";
import { stripeEnabled, issuingRegion, retrieveTopupSession } from "@/lib/stripe";
import { fmt } from "@/lib/policy";
import { Pill, When } from "@/app/components";
import { topupAction } from "@/app/actions";

// Money in. Cards spend from here; nothing else does. The success page from
// Stripe Checkout lands with ?session=… and credits the top-up if the
// webhook has not already (idempotent on the session id).

export default async function BalancePage({ searchParams }: { searchParams: Promise<{ session?: string; topup?: string; error?: string }> }) {
  const ctx = await requireCtx();
  const { session, topup, error } = await searchParams;
  const region = issuingRegion();
  let notice: string | null = null;
  if (session && stripeEnabled() && /^cs_[A-Za-z0-9_]+$/.test(session)) {
    try {
      const s = await retrieveTopupSession(session);
      if (s.paid && s.workspaceId === ctx.workspaceId) {
        const r = await creditTopup(ctx.workspaceId, s.currency, s.amount, "checkout", s.id, s.by);
        notice = `${fmt(s.amount, s.currency)} ${r.credited ? "added" : "was already added"} to the balance.`;
      } else if (!s.paid) notice = "Payment is still processing; the balance updates when Stripe confirms it.";
    } catch (e) { notice = `Could not confirm the payment: ${(e as Error).message}`; }
  }
  const [b, mayFund] = await Promise.all([balanceSummary(ctx.workspaceId, region.currency), can({ workspace: ["settings"] })]);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Prepaid balance · {ctx.workspaceName}</div>
          <h1>{fmt(b.available, b.currency)} available for cards</h1>
          <p className="muted">Virtual cards are paid from this balance. A card authorisation is declined the moment it would take the balance below zero, whatever the mandate allows. The API, MCP and proxy rails don't use it — there the provider bills you directly.</p>
        </div>
      </div>

      {notice && <div className="notice ok" style={{ marginBottom: 16 }}>{notice}</div>}
      {topup === "cancelled" && <div className="notice" style={{ marginBottom: 16 }}>Top-up cancelled; nothing was charged.</div>}
      {error && <div className="notice bad" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="kpis">
        <div className="kpi"><div className="eyebrow">Available</div><div className="v num">{fmt(b.available, b.currency)}</div><div className="s">after holds and captures</div></div>
        <div className="kpi"><div className="eyebrow">Added in total</div><div className="v num">{fmt(b.toppedUp, b.currency)}</div><div className="s">{b.topups.length} top-up{b.topups.length === 1 ? "" : "s"}</div></div>
        <div className="kpi"><div className="eyebrow">Spent or on hold</div><div className="v num">{fmt(b.spent, b.currency)}</div><div className="s">approved card transactions, net of refunds</div></div>
        <div className="kpi"><div className="eyebrow">Currency</div><div className="v num">{b.currency}</div><div className="s">cards are issued in this currency</div></div>
      </div>

      <div className="grid-2" style={{ marginBottom: 24 }}>
        <div className="card">
          <div className="eyebrow" style={{ marginBottom: 8 }}>Add funds</div>
          {!stripeEnabled() ? <p className="muted">Stripe is not configured on this deployment, so cards and top-ups are off. The API, MCP and proxy rails work without them.</p>
            : !mayFund ? <p className="muted">Only owners and admins can add funds.</p>
            : (
            <form action={topupAction} className="form">
              <div className="field">
                <label htmlFor="amount">Amount ({b.currency})</label>
                <input id="amount" name="amount" type="number" step="1" min={MIN_TOPUP / 100} max={MAX_TOPUP / 100} defaultValue="25" required />
                <span className="hint">Between {fmt(MIN_TOPUP, b.currency)} and {fmt(MAX_TOPUP, b.currency)} per top-up. You pay by card on Stripe's checkout page; the amount is credited in full.</span>
              </div>
              <div className="actions"><button className="btn accent" type="submit">Continue to Stripe</button></div>
              <p className="faint" style={{ fontSize: 12.5, margin: 0 }}>Unspent balance is refundable on request: revoke the mandates, then email the operator (see <Link href="/terms">Terms</Link>).</p>
            </form>
          )}
        </div>
        <div className="card">
          <div className="eyebrow" style={{ marginBottom: 8 }}>How a card draws on it</div>
          <p className="muted" style={{ fontSize: 14 }}>When the agent pays, the merchant's request reaches Mandate in real time. The mandate's terms are checked first (merchant, hours, limits, escalation), then the balance. An approval places a hold for the amount; the merchant's capture replaces the hold with what was actually charged, a reversal releases it, a refund credits it back.</p>
          <p className="muted" style={{ fontSize: 14, margin: 0 }}>Issue a mandate with "virtual card" ticked to get a card; the number is shown on the mandate page to owners and admins, through Stripe, and every reveal is in the ledger.</p>
        </div>
      </div>

      <h2 style={{ marginBottom: 8 }}>Top-ups</h2>
      <div className="tbl" style={{ marginBottom: 24 }}>
        <table>
          <thead><tr><th>When</th><th>Amount</th><th>Source</th><th>By</th><th>Reference</th></tr></thead>
          <tbody>
            {b.topups.length === 0 && <tr><td colSpan={5} className="empty">No top-ups yet.</td></tr>}
            {b.topups.map((t) => <tr key={t.id}><td><When d={t.createdAt} /></td><td className="num">{fmt(t.amount, t.currency)}</td><td><Pill v={t.source} /></td><td>{t.by || <span className="faint">—</span>}</td><td className="mono faint" style={{ fontSize: 12 }}>{t.reference.slice(0, 28)}</td></tr>)}
          </tbody>
        </table>
      </div>

      <h2 style={{ marginBottom: 8 }}>Card activity</h2>
      <div className="tbl">
        <table>
          <thead><tr><th>When</th><th>Merchant</th><th className="r">Amount</th><th>Decision</th><th>Status</th></tr></thead>
          <tbody>
            {b.cardActivity.length === 0 && <tr><td colSpan={5} className="empty">No card transactions yet.</td></tr>}
            {b.cardActivity.map((t) => <tr key={t.id}><td><When d={t.createdAt} /></td><td>{t.merchant}</td><td className="r num">{fmt(t.amount, t.currency)}</td><td><Pill v={t.decision} /></td><td className="muted" style={{ fontSize: 13 }}>{t.reason}</td></tr>)}
          </tbody>
        </table>
      </div>
    </>
  );
}
