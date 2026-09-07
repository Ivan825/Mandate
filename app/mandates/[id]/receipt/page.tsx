import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { requireCtx } from "@/lib/session";
import { getMandate, recentTransactions, listApprovals } from "@/lib/service";
import { buildReceipt } from "@/lib/receipts";
import { db, schema } from "@/lib/db";
import { fmt, parseList } from "@/lib/policy";
import { PrintButton } from "./print";

// A printable receipt: the sanction terms, every decision under them, and
// the signed chain head. Print to PDF from the browser; the JSON export is
// the machine-verifiable form.

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const m = await getMandate(ctx.workspaceId, id);
  if (!m) notFound();
  const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.id, m.agentId)).limit(1);
  const [txns, approvals, receipt] = await Promise.all([recentTransactions(ctx.workspaceId, 500, m.id), listApprovals(ctx.workspaceId), buildReceipt(ctx.workspaceId, m.id)]);
  const mine = approvals.filter((a) => a.a.mandateId === m.id);
  const approved = txns.filter((t) => t.t.decision === "approved").reduce((s, t) => s + t.t.amount, 0);
  const sig = receipt.signature;
  return (
    <div className="receipt">
      <style>{`@media print { .topbar, .no-print { display: none !important } .main { padding: 0 } body { background: #fff } .receipt { max-width: none } }`}</style>
      <div className="no-print actions" style={{ marginBottom: 16 }}>
        <PrintButton />
        <a className="btn secondary" href={`/api/ledger/export?mandate=${m.id}`}>Download JSON receipt</a>
      </div>
      <div className="eyebrow">Mandate receipt · {ctx.workspaceName}</div>
      <h1 style={{ margin: "6px 0 4px" }}>{m.name}</h1>
      <p className="muted">Issued to <strong>{agent?.name}</strong> on {new Date(m.createdAt).toLocaleString("en-GB", { timeZone: m.timezone })} · status {m.status} · exported {new Date(receipt.exportedAt).toLocaleString("en-GB", { timeZone: m.timezone })}</p>

      <h2 style={{ margin: "22px 0 8px" }}>Terms</h2>
      <dl className="dl">
        <dt>Per transaction</dt><dd>{fmt(m.perTxnLimit, m.currency)}</dd>
        <dt>Per day</dt><dd>{fmt(m.dailyLimit, m.currency)}</dd>
        <dt>Total sanctioned</dt><dd>{fmt(m.totalLimit, m.currency)}</dd>
        <dt>Escalation</dt><dd>{m.approvalAbove == null ? "never" : `above ${fmt(m.approvalAbove, m.currency)}`}</dd>
        <dt>Merchants</dt><dd>{parseList(m.allowedMerchants).join(", ") || "any"}</dd>
        <dt>Blocked categories</dt><dd>{parseList(m.blockedCategories).join(", ") || "none"}</dd>
        <dt>Active hours</dt><dd>{m.activeHoursStart === 0 && m.activeHoursEnd === 24 ? "all day" : `${m.activeHoursStart}:00–${m.activeHoursEnd}:00`} {m.timezone}</dd>
        <dt>Expires</dt><dd>{m.expiresAt ? new Date(m.expiresAt).toLocaleDateString("en-GB", { timeZone: m.timezone }) : "no expiry"}</dd>
      </dl>

      <h2 style={{ margin: "22px 0 8px" }}>Decisions ({txns.length}) · approved total {fmt(approved, m.currency)}</h2>
      <div className="tbl"><table>
        <thead><tr><th>When</th><th>Merchant</th><th className="r">Amount</th><th>Decision</th><th>Rule</th><th>Via</th></tr></thead>
        <tbody>{txns.map(({ t }) => (
          <tr key={t.id}><td>{new Date(t.createdAt).toLocaleString("en-GB", { timeZone: m.timezone })}</td><td>{t.merchant}{t.purpose && <div className="faint" style={{ fontSize: 12 }}>{t.purpose}</div>}</td><td className="r num">{fmt(t.amount, t.currency)}</td><td>{t.decision}</td><td className="faint" style={{ fontSize: 12.5 }}>{t.reason}</td><td className="mono faint">{t.source}{t.actor ? ` · ${t.actor}` : ""}</td></tr>
        ))}</tbody>
      </table></div>

      {mine.length > 0 && (
        <>
          <h2 style={{ margin: "22px 0 8px" }}>Human decisions</h2>
          <div className="tbl"><table>
            <thead><tr><th>Requested</th><th>Merchant</th><th className="r">Amount</th><th>Outcome</th><th>By</th><th>When</th></tr></thead>
            <tbody>{mine.map(({ a }) => (
              <tr key={a.id}><td>{new Date(a.requestedAt).toLocaleString("en-GB", { timeZone: m.timezone })}</td><td>{a.merchant}</td><td className="r num">{fmt(a.amount, a.currency)}</td><td>{a.status}</td><td>{a.decidedBy ?? ""}</td><td>{a.decidedAt ? new Date(a.decidedAt).toLocaleString("en-GB", { timeZone: m.timezone }) : ""}</td></tr>
            ))}</tbody>
          </table></div>
        </>
      )}

      <h2 style={{ margin: "22px 0 8px" }}>Integrity</h2>
      <p className="muted">Ledger chain: {receipt.verification.ok ? `intact, ${receipt.verification.checked} events verified` : `BROKEN at #${receipt.verification.brokenAt}`}. {receipt.events.length} events concern this mandate.</p>
      {sig && (
        <dl className="dl mono" style={{ fontSize: 12 }}>
          <dt>Head</dt><dd>#{sig.head.seq} · {sig.head.hash}</dd>
          <dt>Signed at</dt><dd>{sig.signedAt}</dd>
          <dt>Key id</dt><dd>{sig.keyId} · public key at /.well-known/mandate-receipt-key</dd>
          <dt>Signature</dt><dd style={{ wordBreak: "break-all" }}>{sig.signature}</dd>
        </dl>
      )}
      <p className="faint" style={{ fontSize: 12 }}>Verify offline: Ed25519 over the message <span className="mono">{sig?.message}</span>, or POST the JSON receipt to /api/receipts/verify.</p>
    </div>
  );
}
