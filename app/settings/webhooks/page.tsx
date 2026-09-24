import Link from "next/link";
import { requireCtx, can } from "@/lib/session";
import { listEndpoints, recentDeliveries, parseFilter, MAX_ENDPOINTS, MAX_ATTEMPTS } from "@/lib/webhooks";
import { decrypt } from "@/lib/crypto";
import { grantValid } from "@/lib/reveal";
import { appUrl } from "@/lib/env";
import { Pill, When } from "@/app/components";
import { addWebhookEndpointAction, rotateWebhookSecretAction, toggleWebhookEndpointAction, removeWebhookEndpointAction, testWebhookEndpointAction, retryWebhookDeliveryAction } from "@/app/actions";

export const metadata = { title: "Event webhooks" };

export default async function WebhooksPage({ searchParams }: { searchParams: Promise<{ reveal?: string; g?: string; error?: string; test?: string; removed?: string }> }) {
  const ctx = await requireCtx();
  const { reveal, g, error, test, removed } = await searchParams;
  const manage = await can({ workspace: ["settings"] });
  const [endpoints, deliveries] = await Promise.all([listEndpoints(ctx.workspaceId), recentDeliveries(ctx.workspaceId, 40)]);
  const revealed = reveal && grantValid(reveal, g) ? endpoints.find((e) => e.id === reveal) : null;
  const secret = revealed ? safeDecrypt(revealed.secretCiphertext) : null;
  const base = appUrl();

  return (
    <div style={{ maxWidth: 860 }}>
      <div className="eyebrow"><Link href="/settings">Settings</Link> · Event webhooks</div>
      <h1>Every event in this workspace, pushed to your own systems</h1>
      <p className="muted" style={{ margin: "8px 0 20px" }}>Each ledger event — grants, decisions, captures, approvals, revocations, member changes — is POSTed as signed JSON to the endpoints below, in order, with retries. Point one at n8n, Zapier, Make, a Slack bridge, a spreadsheet, your finance system, or a dashboard you build. (Approval <em>notifications</em> with approve/deny links are separate and per person: <Link href="/settings">Settings → How to reach you</Link>.)</p>

      {error && <div className="notice bad" style={{ marginBottom: 12 }}>{error}</div>}
      {removed && <div className="notice ok" style={{ marginBottom: 12 }}>Endpoint removed.</div>}
      {test && <div className={`notice ${test === "ok" ? "ok" : "bad"}`} style={{ marginBottom: 12 }}>{test === "ok" ? "Test event delivered (2xx)." : `Test event failed: ${test}`}</div>}
      {revealed && secret && (
        <div className="notice" style={{ marginBottom: 20 }}>
          <strong>Signing secret for {revealed.url} — copy it now; it is shown only this once.</strong>
          <div className="token" style={{ margin: "10px 0 6px" }}>{secret}</div>
          Verify each delivery: <code>Mandate-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</code> where <code>v1 = HMAC-SHA256(secret, `${"{t}"}.${"{raw body}"}`)</code>. Reject if <code>t</code> is more than five minutes old. Lost it? Rotate below.
        </div>
      )}
      {revealed && !secret && <div className="notice bad" style={{ marginBottom: 20 }}>The secret could not be read (MANDATE_ENCRYPTION_KEY changed?). Rotate it.</div>}

      <h2 style={{ marginBottom: 8 }}>Endpoints <span className="faint" style={{ fontWeight: 400, fontSize: 13 }}>{endpoints.length} of {MAX_ENDPOINTS}</span></h2>
      <div className="tbl" style={{ marginBottom: 12 }}>
        <table>
          <thead><tr><th>URL</th><th>Events</th><th>State</th><th>Last delivery</th><th></th></tr></thead>
          <tbody>
            {endpoints.length === 0 && <tr><td colSpan={5} className="empty">No endpoints yet. Add one below; you'll get its signing secret once.</td></tr>}
            {endpoints.map((e) => {
              const f = parseFilter(e.events);
              return (
                <tr key={e.id}>
                  <td className="mono" style={{ fontSize: 12.5, maxWidth: 300, wordBreak: "break-all" }}>{e.url}{e.description && <div className="faint" style={{ fontFamily: "var(--sans)", fontSize: 12 }}>{e.description}</div>}<div className="faint" style={{ fontSize: 11 }}>secret ···{e.secretHint}</div></td>
                  <td className="mono" style={{ fontSize: 12 }}>{f === "*" ? "all" : f.join(" ")}</td>
                  <td>{e.enabled ? <Pill v="active" /> : <Pill v="paused" />}{e.disabledReason && <div className="faint" style={{ fontSize: 11.5, maxWidth: 220 }}>{e.disabledReason}</div>}{e.enabled === 1 && e.consecutiveFailures > 0 && <div className="faint" style={{ fontSize: 11.5 }}>{e.consecutiveFailures} failing in a row</div>}</td>
                  <td><When d={e.lastDeliveryAt} />{e.lastStatus != null && <div className="mono faint" style={{ fontSize: 11.5 }}>HTTP {e.lastStatus}</div>}</td>
                  <td>
                    {manage && (
                      <div className="stack" style={{ gap: 4 }}>
                        <form action={testWebhookEndpointAction}><input type="hidden" name="id" value={e.id} /><button className="btn secondary sm" type="submit">Send test</button></form>
                        <form action={toggleWebhookEndpointAction}><input type="hidden" name="id" value={e.id} /><input type="hidden" name="enabled" value={e.enabled ? "0" : "1"} /><button className="btn secondary sm" type="submit">{e.enabled ? "Pause" : "Enable"}</button></form>
                        <form action={rotateWebhookSecretAction}><input type="hidden" name="id" value={e.id} /><button className="btn secondary sm" type="submit">Rotate secret</button></form>
                        <form action={removeWebhookEndpointAction}><input type="hidden" name="id" value={e.id} /><button className="btn danger sm" type="submit">Remove</button></form>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {manage ? (
        <div className="grid-2" style={{ marginBottom: 28 }}>
          <form action={addWebhookEndpointAction} className="card form">
            <div className="eyebrow">Add an endpoint</div>
            <div className="field"><label htmlFor="url">URL</label><input id="url" name="url" required placeholder="https://hooks.example.com/mandate" /><span className="hint">https, on the public internet. No credentials in the URL.</span></div>
            <div className="field"><label htmlFor="events">Events</label><input id="events" name="events" defaultValue="*" placeholder="* or e.g. authorization., approval.approved, mandate.revoked" /><span className="hint">Comma-separated. A trailing dot is a prefix: <code>authorization.</code> is every decision, capture and void.</span></div>
            <div className="field"><label htmlFor="description">Label (optional)</label><input id="description" name="description" placeholder="n8n finance flow" /></div>
            <div className="actions"><button className="btn accent" type="submit">Add endpoint</button></div>
          </form>
          <div className="card">
            <div className="eyebrow" style={{ marginBottom: 6 }}>What arrives</div>
            <pre style={{ fontSize: 11.5, margin: 0 }}>{`POST <your url>
Content-Type: application/json
Mandate-Event: authorization.approved
Mandate-Event-Id: evt_…      (same for every endpoint)
Mandate-Delivery: …          (unique per endpoint + attempt chain)
Mandate-Signature: t=1758700000,v1=…

{
  "id": "evt_…", "type": "authorization.approved",
  "seq": 42, "hash": "…",  // position and hash in the ledger chain
  "workspaceId": "…", "createdAt": "…",
  "summary": "Claude was allowed $12.99 at OpenAI — held until captured.",
  "data": { …the event payload… }
}`}</pre>
            <p className="faint" style={{ fontSize: 12.5, marginTop: 8 }}>Answer 2xx within 8 s. Anything else is retried after 1 min, 5 min, 30 min, 2 h and 12 h ({MAX_ATTEMPTS} attempts), and an endpoint that fails 25 deliveries in a row is paused. Deliveries to one endpoint go in ledger order. <code>Mandate-Event-Id</code> lets you de-duplicate. Test from <code>{base}</code>: the signature covers the exact bytes of the body.</p>
          </div>
        </div>
      ) : <p className="muted" style={{ marginBottom: 28 }}>Owners and admins manage endpoints.</p>}

      <h2 style={{ marginBottom: 8 }}>Recent deliveries</h2>
      <div className="tbl">
        <table>
          <thead><tr><th>When</th><th>Event</th><th>Endpoint</th><th>Status</th><th>Attempts</th><th></th></tr></thead>
          <tbody>
            {deliveries.length === 0 && <tr><td colSpan={6} className="empty">Nothing sent yet.</td></tr>}
            {deliveries.map((d) => (
              <tr key={d.id}>
                <td><When d={d.createdAt} /></td>
                <td className="mono" style={{ fontSize: 12 }}>{d.eventType}{d.ledgerSeq > 0 && <span className="faint"> #{d.ledgerSeq}</span>}</td>
                <td className="mono faint" style={{ fontSize: 11.5, maxWidth: 220, wordBreak: "break-all" }}>{d.url}</td>
                <td><Pill v={d.status} />{d.lastError && <div className="faint" style={{ fontSize: 11.5 }}>{d.lastError}</div>}{d.lastStatusCode != null && !d.lastError && <div className="mono faint" style={{ fontSize: 11.5 }}>HTTP {d.lastStatusCode}</div>}</td>
                <td className="num">{d.attempts}{d.status === "pending" && d.attempts > 0 && <div className="faint" style={{ fontSize: 11.5 }}>next <When d={d.nextAttemptAt} /></div>}</td>
                <td>{manage && d.status !== "delivered" && d.eventType !== "test" && <form action={retryWebhookDeliveryAction}><input type="hidden" name="id" value={d.id} /><button className="btn secondary sm" type="submit">Retry now</button></form>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function safeDecrypt(ct: string): string | null { try { return decrypt(ct); } catch { return null; } }
