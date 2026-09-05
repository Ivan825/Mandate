import { notFound, redirect } from "next/navigation";
import { verifyLink } from "@/lib/notify";
import { decideApproval, getApproval } from "@/lib/service";
import { fmt } from "@/lib/policy";
import { rateLimit } from "@/lib/ratelimit";
import { headers } from "next/headers";

// One-tap decision from a notification. The link is signed and expires with
// the approval. GET shows a confirmation (messengers and mail clients prefetch
// links, so a GET must never decide anything); the button POSTs the decision.
// No sign-in is needed: the signature is the proof the link came from us.

type Params = { params: Promise<{ id: string }>; searchParams: Promise<{ d?: string; t?: string; done?: string }> };

export default async function OneTapPage({ params, searchParams }: Params) {
  const { id } = await params;
  const { d, t, done } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const decision = d === "approve" ? "approve" : d === "deny" ? "deny" : null;
  const row = await getApproval(id);
  if (!row) notFound();
  const valid = decision && t ? verifyLink(id, decision, t) : false;
  const a = row.a;

  async function decide(form: FormData) {
    "use server";
    const dec = String(form.get("d")) === "approve" ? "approve" : "deny";
    const tok = String(form.get("t") ?? "");
    const h = await headers();
    const ip = (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
    if (!(await rateLimit(`ip:${ip}:onetap`, 30)).ok) return;
    if (!verifyLink(id, dec, tok)) return;
    await decideApproval(null, id, dec === "approve" ? "approved" : "denied", "one-tap link");
    redirect(`/a/${id}?done=${dec}`);
  }

  return (
    <div style={{ maxWidth: 440, margin: "40px auto" }}>
      <div className="eyebrow">Mandate · one-tap decision</div>
      <h1 style={{ margin: "6px 0 14px" }}>{fmt(a.amount, a.currency)} <span className="muted" style={{ fontFamily: "var(--sans)", fontWeight: 400, fontSize: 18 }}>at {a.merchant}</span></h1>
      <div className="card stack">
        <dl className="dl">
          <dt>Agent</dt><dd>{row.agentName}</dd>
          <dt>Mandate</dt><dd>{row.mandateName}</dd>
          {a.purpose && <><dt>Purpose</dt><dd>“{a.purpose}”</dd></>}
          <dt>Status</dt><dd><span className={`pill ${a.status}`}>{a.status}</span></dd>
        </dl>
        {done && <div className={`notice ${done === "approve" ? "ok" : "bad"}`}>{done === "approve" ? "Approved once. The agent can now retry this exact purchase within 24 hours." : "Denied. The agent cannot ask for this again for 6 hours."}</div>}
        {!done && a.status !== "pending" && <div className="notice">This request is already {a.status}.</div>}
        {!done && a.status === "pending" && !valid && <div className="notice bad">This link is invalid or has expired. Decide from the inbox instead.</div>}
        {!done && a.status === "pending" && valid && decision && (
          <form action={decide} className="actions">
            <input type="hidden" name="d" value={decision} />
            <input type="hidden" name="t" value={t} />
            <button className={`btn ${decision === "approve" ? "ok" : "danger"}`} type="submit">{decision === "approve" ? "Confirm: approve once" : "Confirm: deny"}</button>
          </form>
        )}
      </div>
    </div>
  );
}
