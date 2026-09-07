"use client";

import { useActionState, useEffect, useState } from "react";
import Link from "next/link";
import { createMandateAction, type MandateFormState } from "@/app/actions";

type AgentOpt = { id: string; name: string };

export function MandateForm({ agents, defaultAgent, stripeOn }: { agents: AgentOpt[]; defaultAgent: string; stripeOn: boolean }) {
  const [state, action, pending] = useActionState<MandateFormState, FormData>(createMandateAction, undefined);
  const err = (field: string) => state?.errors?.find((e) => e.field === field)?.message;
  const v = (field: string, fallback = "") => state?.values?.[field] ?? fallback;
  // Default the mandate's clock to the browser's zone; the list is every
  // zone the runtime knows, with the browser's own first.
  const [zones, setZones] = useState<string[]>(["UTC"]);
  const [browserZone, setBrowserZone] = useState("UTC");
  useEffect(() => {
    try {
      const mine = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [mine, "UTC"];
      setBrowserZone(mine);
      setZones([mine, ...all.filter((z) => z !== mine)]);
    } catch { /* keep UTC */ }
  }, []);

  return (
    <form action={action} className="form" key={state?.errors ? JSON.stringify(state.values) : "fresh"}>
      {state?.errors?.length ? (
        <div className="notice bad">Check the highlighted terms: {state.errors.map((e) => e.message).join(" ")}</div>
      ) : null}

      <fieldset>
        <legend>Principal</legend>
        <div className="row">
          <div className="field">
            <label htmlFor="agentId">Agent</label>
            <select id="agentId" name="agentId" defaultValue={v("agentId", defaultAgent)} required>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="name">Mandate name</label>
            <input id="name" name="name" required defaultValue={v("name")} placeholder="e.g. Dev tooling, Sept 2026" aria-invalid={Boolean(err("name"))} />
            {err("name") && <span className="hint" style={{ color: "var(--bad)" }}>{err("name")}</span>}
          </div>
        </div>
      </fieldset>

      <fieldset>
        <legend>Limits</legend>
        <div className="row-3">
          <div className="field">
            <label htmlFor="currency">Currency</label>
            <select id="currency" name="currency" defaultValue={v("currency", "USD")}>
              <option value="USD">USD</option><option value="INR">INR</option><option value="EUR">EUR</option><option value="GBP">GBP</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="perTxnLimit">Per transaction</label>
            <input id="perTxnLimit" name="perTxnLimit" type="number" min="0.01" step="0.01" required defaultValue={v("perTxnLimit", "25")} aria-invalid={Boolean(err("perTxnLimit"))} />
          </div>
          <div className="field">
            <label htmlFor="dailyLimit">Per day</label>
            <input id="dailyLimit" name="dailyLimit" type="number" min="0.01" step="0.01" required defaultValue={v("dailyLimit", "50")} aria-invalid={Boolean(err("dailyLimit"))} />
            {err("dailyLimit") && <span className="hint" style={{ color: "var(--bad)" }}>{err("dailyLimit")}</span>}
          </div>
        </div>
        <div className="row">
          <div className="field">
            <label htmlFor="totalLimit">Total sanctioned</label>
            <input id="totalLimit" name="totalLimit" type="number" min="0.01" step="0.01" required defaultValue={v("totalLimit", "200")} aria-invalid={Boolean(err("totalLimit"))} />
            <span className="hint">{err("totalLimit") ?? "Lifetime cap for this mandate. Issue a new one to renew."}</span>
          </div>
          <div className="field">
            <label htmlFor="approvalAbove">Ask me above</label>
            <input id="approvalAbove" name="approvalAbove" type="number" min="0" step="0.01" defaultValue={v("approvalAbove", "10")} aria-invalid={Boolean(err("approvalAbove"))} />
            <span className="hint" style={err("approvalAbove") ? { color: "var(--bad)" } : undefined}>{err("approvalAbove") ?? "Leave blank to never escalate. Above this, the agent is paused until you approve in the inbox. Approvals lapse after 24 hours."}</span>
          </div>
        </div>
      </fieldset>

      <fieldset>
        <legend>Scope</legend>
        <div className="row">
          <div className="field">
            <label htmlFor="allowedMerchants">Allowed merchants</label>
            <textarea id="allowedMerchants" name="allowedMerchants" defaultValue={v("allowedMerchants")} placeholder={"OpenAI\nAnthropic\nVercel*\n(blank = any merchant)"} />
            <span className="hint">One per line, exact name. A trailing * matches a prefix. Blank means any merchant.</span>
          </div>
          <div className="field">
            <label htmlFor="blockedCategories">Blocked categories</label>
            <textarea id="blockedCategories" name="blockedCategories" defaultValue={v("blockedCategories", "gambling\ncrypto\ncash_advance")} />
            <span className="hint">Stripe MCC category slugs, one per line.</span>
          </div>
        </div>
        <div className="row-3">
          <div className="field">
            <label htmlFor="activeHoursStart">Active from (hour)</label>
            <input id="activeHoursStart" name="activeHoursStart" type="number" min="0" max="23" defaultValue={v("activeHoursStart", "0")} aria-invalid={Boolean(err("activeHoursStart"))} />
          </div>
          <div className="field">
            <label htmlFor="activeHoursEnd">Active until (hour)</label>
            <input id="activeHoursEnd" name="activeHoursEnd" type="number" min="1" max="24" defaultValue={v("activeHoursEnd", "24")} aria-invalid={Boolean(err("activeHoursEnd"))} />
            <span className="hint" style={err("activeHoursEnd") ? { color: "var(--bad)" } : undefined}>{err("activeHoursEnd") ?? "0 to 24 = all day. 8 to 23 blocks night-time spending."}</span>
          </div>
          <div className="field">
            <label htmlFor="timezone">Timezone</label>
            <select id="timezone" name="timezone" defaultValue={v("timezone", browserZone)} key={browserZone}>
              {zones.map((z) => <option key={z}>{z}</option>)}
            </select>
          </div>
        </div>
        <div className="field" style={{ maxWidth: 260 }}>
          <label htmlFor="expiresAt">Expires on</label>
          <input id="expiresAt" name="expiresAt" type="date" defaultValue={v("expiresAt", new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10))} />
          <span className="hint">Valid until the end of that day in the mandate's timezone. Defaults to 30 days; renew by issuing a new one.</span>
        </div>
      </fieldset>

      <fieldset>
        <legend>Card</legend>
        {stripeOn ? (
          <label className="check"><input type="checkbox" name="issueCard" defaultChecked={state?.values ? v("issueCard") === "on" : true} /> Issue a Stripe virtual card bound to this mandate (real-time authorisation)</label>
        ) : (
          <p className="muted" style={{ margin: 0 }}>Stripe Issuing is not configured, so no card will be issued. The mandate still works through the agent API. Add <code>STRIPE_SECRET_KEY</code> to enable virtual cards.</p>
        )}
      </fieldset>

      <div className="actions">
        <button className="btn accent" type="submit" disabled={pending}>{pending ? "Issuing…" : "Issue mandate"}</button>
        <Link href="/" className="btn secondary">Cancel</Link>
      </div>
    </form>
  );
}
