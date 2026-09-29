import { notFound, redirect } from "next/navigation";
import { parsePlanLink, linkPrincipal } from "@/lib/notify";
import { decidePlan, getPlan, planView } from "@/lib/service";
import { fmt } from "@/lib/policy";
import { rateLimit, clientIp } from "@/lib/ratelimit";
import { headers } from "next/headers";

// One-tap decision on a plan from a notification: same shape as /a/:id —
// GET shows what would be approved, the button POSTs with the signed token.
type Params = { params: Promise<{ id: string }>; searchParams: Promise<{ d?: string; t?: string; done?: string; err?: string }> };

export default async function PlanOneTapPage({ params, searchParams }: Params) {
  const { id } = await params;
  const { d, t, done, err } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const decision = d === "approve" ? "approve" : d === "deny" ? "deny" : null;
  const plan = await getPlan({}, id);
  if (!plan) notFound();
  const workspaceId = plan.workspaceId;
  const link = decision && t ? parsePlanLink(id, decision, t) : { ok: false, userId: null };
  const valid = link.ok;
  const v = planView(plan);
  // Without a valid link the page reveals nothing about the plan.
  if (!valid) return <div style={{ maxWidth: 480, margin: "40px auto" }}><div className="eyebrow">Mandate · plan</div><div className="notice bad" style={{ marginTop: 12 }}>This link is invalid or has expired. Decide from the <a href="/approvals">inbox</a> instead.</div></div>;

  async function decide(form: FormData) {
    "use server";
    const dec = String(form.get("d")) === "approve" ? "approve" : "deny";
    const tok = String(form.get("t") ?? "");
    const h = await headers();
    if (!(await rateLimit(`ip:${clientIp(new Request("http://x", { headers: h }))}:onetap`, 30)).ok) return;
    const l = parsePlanLink(id, dec, tok);
    if (!l.ok) return;
    const who = await linkPrincipal(l.userId, workspaceId);
    if (who === "revoked") redirect(`/p/${id}?d=${dec}&t=${encodeURIComponent(tok)}&done=${dec}&err=revoked`);
    await decidePlan(null, id, dec === "approve" ? "approved" : "denied", who ? who.email : "one-tap link");
    redirect(`/p/${id}?d=${dec}&t=${encodeURIComponent(tok)}&done=${dec}`);
  }

  return (
    <div style={{ maxWidth: 480, margin: "40px auto" }}>
      <div className="eyebrow">Mandate · plan</div>
      <h1 style={{ margin: "6px 0 4px" }}>{v.title}</h1>
      <p className="muted" style={{ margin: "0 0 14px" }}>{v.items.length} item{v.items.length === 1 ? "" : "s"}, up to {fmt(v.totalMax, v.currency)} in total. Approving lets each item through once without asking; anything outside the list still asks.</p>
      <div className="card stack">
        <table className="mini"><tbody>{v.items.map((it) => <tr key={it.index}><td>{it.merchant}{it.purpose && <div className="faint" style={{ fontSize: 12 }}>{it.purpose}</div>}</td><td className="r num">up to {fmt(it.amount, v.currency)}</td></tr>)}</tbody></table>
        <div><span className={`pill ${v.status}`}>{v.status}</span></div>
        {done && err === "revoked" && <div className="notice bad">You can no longer decide requests in this workspace, so nothing was changed.</div>}
        {done && !err && <div className={`notice ${done === "approve" ? "ok" : "bad"}`}>{done === "approve" ? "Plan approved. Each item can go through once, for the next 7 days." : "Plan denied."}</div>}
        {!done && plan.status !== "proposed" && <div className="notice">This plan is already {plan.status}.</div>}
        {!done && plan.status === "proposed" && valid && decision && (
          <form action={decide} className="actions"><input type="hidden" name="d" value={decision} /><input type="hidden" name="t" value={t} /><button className={`btn ${decision === "approve" ? "ok" : "danger"}`} type="submit">{decision === "approve" ? "Confirm: approve the plan" : "Confirm: deny"}</button></form>
        )}
      </div>
    </div>
  );
}
