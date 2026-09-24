import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { buildTransactionReceipt } from "@/lib/receipts";
import { appUrl } from "@/lib/env";
import { fmt } from "@/lib/money";
import { FLAG_LABELS, type Flag } from "@/lib/anomaly";
import { describeEvent } from "@/lib/activity";
import { Pill } from "@/app/components";
import { Verify } from "./verify";

// A public receipt for one decision. Anyone with the link can read it and
// verify it; nobody needs an account. The link is the capability: the
// owner can stop sharing at any time, after which this is a 404.

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ k?: string }> };

async function load(props: Props) {
  const { id } = await props.params;
  const { k } = await props.searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id) || !k || !/^[A-Za-z0-9_-]{16,64}$/.test(k)) return null;
  return { id, k, r: await buildTransactionReceipt(id, k, appUrl()) };
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const l = await load(props);
  if (!l?.r) return { title: "Receipt" };
  const t = l.r.transaction as { amount: number; currency: string; merchant: string; decision: string };
  const title = `${fmt(t.amount, t.currency)} at ${t.merchant} — ${t.decision}`;
  return { title, description: `Signed Mandate receipt: ${l.r.agent.name} under “${(l.r.mandate as { name: string }).name}”. Verifiable by anyone.`, openGraph: { title: `${title} · Mandate receipt`, description: "A signed, verifiable record of an AI agent's spending decision." }, robots: { index: false } };
}

export default async function PublicReceiptPage(props: Props) {
  const l = await load(props);
  if (!l?.r) notFound();
  const r = l.r;
  const t = r.transaction as { id: string; createdAt: string; decision: string; reason: string; source: string; actor: string; amount: number; authorizedAmount: number; currency: string; merchant: string; category: string; purpose: string; settlement: string | null; settledAt: string | null; settledBy: string | null; settlementNote: string | null; flags: Flag[] };
  const m = r.mandate as { name: string; currency: string; perTxnLimit: number; dailyLimit: number; totalLimit: number; approvalAbove: number | null; allowedMerchants: string[]; activeHours: [number, number]; timezone: string; issuedAt: string };
  const a = r.approval as { status: string; decidedAt: string | null; decidedBy: string | null } | null;
  const base = appUrl();
  const jsonUrl = `${base}/api/receipts/tx/${l.id}?k=${l.k}`;
  const when = (iso: string | null | undefined) => (iso ? new Date(iso).toUTCString().replace(" GMT", " UTC") : "—");
  return (
    <div style={{ maxWidth: 760, margin: "0 auto" }}>
      <div className="eyebrow">Mandate · signed receipt</div>
      <h1 style={{ marginBottom: 4 }}>{fmt(t.amount, t.currency)} <span className="muted" style={{ fontFamily: "var(--sans)", fontWeight: 400, fontSize: 20 }}>at {t.merchant}</span> <Pill v={t.decision} />{t.settlement && <> <Pill v={t.settlement} /></>}</h1>
      <p className="muted" style={{ margin: "0 0 18px" }}><strong>{r.agent.name}</strong> asked on {when(t.createdAt)} under the mandate <strong>“{m.name}”</strong>{t.purpose && <> — “{t.purpose}”</>}. Mandate answered: <em>{t.reason}</em></p>
      {t.flags?.length > 0 && <p className="muted" style={{ marginTop: -10 }}>Flagged at the time: {t.flags.map((f) => FLAG_LABELS[f]?.label ?? f).join(", ")}.</p>}

      <div className="grid-2">
        <div className="card">
          <div className="eyebrow">The decision</div>
          <dl className="dl">
            <dt>Authorised</dt><dd className="num">{fmt(t.authorizedAmount, t.currency)}</dd>
            {t.settlement && t.settlement !== "held" && <><dt>{t.settlement === "captured" ? "Captured" : t.settlement === "voided" ? "Voided" : "Released"}</dt><dd className="num">{t.settlement === "captured" ? fmt(t.amount, t.currency) : fmt(t.authorizedAmount, t.currency)}{t.settledBy && <span className="faint"> · by {t.settledBy}</span>}{t.settledAt && <div className="faint" style={{ fontSize: 12 }}>{when(t.settledAt)}</div>}</dd></>}
            {t.settlement === "held" && <><dt>Hold</dt><dd>open — not yet settled</dd></>}
            <dt>Via</dt><dd className="mono">{t.source}{t.actor && ` · ${t.actor}`}</dd>
            {a && <><dt>Human approval</dt><dd>{a.status}{a.decidedBy && <> by {a.decidedBy}</>}{a.decidedAt && <div className="faint" style={{ fontSize: 12 }}>{when(a.decidedAt)}</div>}</dd></>}
            <dt>Transaction</dt><dd className="mono" style={{ fontSize: 12 }}>{t.id}</dd>
          </dl>
        </div>
        <div className="card">
          <div className="eyebrow">Terms it was decided under</div>
          <dl className="dl">
            <dt>Per transaction</dt><dd className="num">{fmt(m.perTxnLimit, m.currency)}</dd>
            <dt>Per day</dt><dd className="num">{fmt(m.dailyLimit, m.currency)}</dd>
            <dt>Total</dt><dd className="num">{fmt(m.totalLimit, m.currency)}</dd>
            <dt>Asks above</dt><dd className="num">{m.approvalAbove == null ? "never" : fmt(m.approvalAbove, m.currency)}</dd>
            <dt>Merchants</dt><dd>{m.allowedMerchants?.length ? m.allowedMerchants.join(", ") : <span className="faint">any</span>}</dd>
            <dt>Hours</dt><dd className="num">{m.activeHours?.[0] === 0 && m.activeHours?.[1] === 24 ? "all day" : `${m.activeHours?.[0]}:00–${m.activeHours?.[1]}:00`} {m.timezone}</dd>
            <dt>Issued</dt><dd>{when(m.issuedAt)}</dd>
          </dl>
        </div>
      </div>

      <h2 style={{ margin: "24px 0 8px" }}>What the ledger recorded</h2>
      <p className="faint" style={{ fontSize: 12.5, margin: "0 0 8px" }}>Each row is an entry in the workspace's hash chain; the hash covers the previous row's hash, so none of these can be edited or removed without breaking every later row. Chain head at signing: #{r.chain.head.seq} <span className="mono">{r.chain.head.hash.slice(0, 16)}…</span>{r.chain.verified ? " · chain verified intact" : " · chain verification failed"}.</p>
      <div className="tbl">
        <table>
          <thead><tr><th className="r">#</th><th>When (UTC)</th><th>What happened</th><th>Hash</th></tr></thead>
          <tbody>
            {r.events.map((e) => (
              <tr key={e.seq}><td className="r num mono">{e.seq}</td><td style={{ whiteSpace: "nowrap", fontSize: 12.5 }}>{when(e.createdAt)}</td><td>{describeEvent(e.type, e.payload as Record<string, unknown>, { agent: r.agent.name, mandate: m.name }).summary}<div className="mono faint" style={{ fontSize: 11 }}>{e.type}</div></td><td className="chain"><span title={e.hash}>{e.hash.slice(0, 12)}…</span><br /><span className="h" title={e.prevHash}>← {e.prevHash.slice(0, 12)}…</span></td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <Verify jsonUrl={jsonUrl} keyUrl={`${base}/.well-known/mandate-receipt-key`} id={l.id} />
      <p className="faint" style={{ fontSize: 12.5, marginTop: 12 }}>Signed by <span className="mono">{r.issuer}</span> (key {r.signature.keyId}) at {when(r.signature.signedAt)}. <a href={jsonUrl}>Download the JSON</a>. Made with <a href={base}>Mandate</a> — scoped, revocable spending authority for AI agents.</p>
    </div>
  );
}
