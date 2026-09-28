import type { Metadata } from "next";
import { listAnchors, anchorView, verifyAnchors } from "@/lib/anchors";
import { keyId } from "@/lib/receipts";
import { appUrl } from "@/lib/env";

export const metadata: Metadata = { title: "Public ledger anchors", description: "Signed daily statements of where every Mandate ledger stood. Anyone can check that a receipt's history was published when it says it was.", robots: { index: true } };
export const dynamic = "force-dynamic";

// Public. No account needed. Every line is a signed statement that one
// workspace's ledger (named by a hash) stood at (seq, hash) at signedAt,
// chained to the line before it. Copy a line somewhere Mandate does not
// control and the deployment cannot rewrite history without you noticing.
export default async function AnchorsPage({ searchParams }: { searchParams: Promise<{ label?: string; before?: string }> }) {
  const { label, before } = await searchParams;
  const rows = (await listAnchors({ limit: label ? 500 : 100, before: Number(before) || undefined })).filter((a) => !label || a.label === label).slice(0, 100);
  const v = await verifyAnchors();
  const base = appUrl();
  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      <div className="eyebrow">Mandate · public anchors</div>
      <h1>Where every ledger stood, signed and published</h1>
      <p className="muted" style={{ margin: "8px 0 16px" }}>Each Mandate workspace keeps a hash-chained ledger of everything its agents were allowed, refused or asked. A chain proves nothing was edited in the middle; these anchors prove the chain was not quietly rebuilt afterwards. Once a day the head of every ledger that moved is signed here, chained to the previous anchor. A workspace appears only as the hash of its id. Anyone holding a receipt can find the anchor that covers it{label ? " — you are looking at one workspace's anchors" : ""}. Key <span className="mono">{keyId()}</span> · <a href={`${base}/.well-known/mandate-receipt-key`}>public key</a> · <a href={`${base}/api/ledger/anchors${label ? `?label=${label}` : ""}`}>JSON</a>.</p>
      <div className={`notice ${v.ok ? "ok" : "bad"}`} style={{ marginBottom: 16 }}>{v.ok ? <><strong>Anchor chain intact.</strong> {v.checked} anchor{v.checked === 1 ? "" : "s"} re-verified just now: every hash, link and signature{v.otherKey > 0 ? ` (${v.otherKey} signed with an earlier key; their hashes still bind them into the chain)` : ""}.</> : <><strong>Anchor chain broken at #{v.brokenAt}.</strong> {v.detail}.</>}</div>
      <div className="tbl">
        <table>
          <thead><tr><th className="r">#</th><th>Signed (UTC)</th><th>Ledger</th><th className="r">Head</th><th>Head hash</th><th>Anchor hash</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={6} className="empty">No anchors yet. The first daily run writes the first line.</td></tr>}
            {rows.map((a) => { const x = anchorView(a); return (
              <tr key={a.id}><td className="r num mono">{x.n}</td><td style={{ whiteSpace: "nowrap", fontSize: 12.5 }}>{x.signedAt.replace("T", " ").replace(/\.\d+Z$/, "")}</td><td><a className="mono" style={{ fontSize: 12 }} href={`/anchors?label=${x.label}`} title={x.label}>{x.label.slice(0, 16)}…</a></td><td className="r num mono">{x.seq}</td><td className="chain"><span title={x.hash}>{x.hash.slice(0, 16)}…</span></td><td className="chain"><span title={x.anchorHash}>{x.anchorHash.slice(0, 16)}…</span><br /><span className="h" title={x.prevAnchorHash}>← {x.prevAnchorHash.slice(0, 12)}…</span></td></tr>
            ); })}
          </tbody>
        </table>
      </div>
      {rows.length === 100 && <p style={{ marginTop: 10 }}><a className="btn secondary sm" href={`/anchors?before=${rows[rows.length - 1].n}${label ? `&label=${label}` : ""}`}>Older</a></p>}
      <h2 style={{ margin: "24px 0 8px" }}>Check one yourself</h2>
      <pre className="code" style={{ fontSize: 12 }}>{`anchorHash = sha256(n + "|" + label + "|" + seq + "|" + hash + "|" + prevAnchorHash + "|" + signedAt)
Ed25519.verify(publicKey, "mandate-anchor|" + anchorHash, base64decode(signature))
label      = sha256("mandate-ws:" + workspaceId)     # so a receipt's owner can find their line`}</pre>
      <p className="faint" style={{ fontSize: 12.5 }}>Every field is in the <a href={`${base}/api/ledger/anchors`}>JSON</a>. To pin this deployment's history outside its control, copy the newest line each day into a place you own — a git commit, a post, a colleague's log. Made with <a href={base}>Mandate</a>.</p>
    </div>
  );
}
