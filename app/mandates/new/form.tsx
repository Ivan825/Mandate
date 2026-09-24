"use client";

import { useActionState, useEffect, useState } from "react";
import Link from "next/link";
import { createMandateAction, type MandateFormState } from "@/app/actions";
import { CURRENCIES, inputStep, minorUnits } from "@/lib/money";

type AgentOpt = { id: string; name: string };

export function MandateForm({ agents, defaultAgent, stripeOn, cardProblem, cardCurrency, defaultCurrency, initial, initialLabel, next }: { agents: AgentOpt[]; defaultAgent: string; stripeOn: boolean; cardProblem: string | null; cardCurrency: string; defaultCurrency: string; initial?: Record<string, string>; initialLabel?: string; next?: { next: string; rail: string } }) {
  const [state, action, pending] = useActionState<MandateFormState, FormData>(createMandateAction, undefined);
  const err = (field: string) => state?.errors?.find((e) => e.field === field)?.message;
  // Values come back from a failed submit first, then from a template or a
  // mandate being duplicated, then the plain defaults.
  const v = (field: string, fallback = "") => state?.values?.[field] ?? initial?.[field] ?? fallback;
  // Amount inputs step in the chosen currency's minor unit (0.01, 1 or 0.001).
  const [currency, setCurrency] = useState(v("currency", defaultCurrency));
  const step = inputStep(currency);
  // Suggested limits are dollar-ish figures scaled roughly into the chosen
  // currency, so a rupee mandate doesn't start at ₹25.
  const ROUGH: Record<string, number> = { INR: 80, JPY: 150, KRW: 1300, IDR: 16000, VND: 25000, PHP: 55, THB: 35, EGP: 50, PKR: 280, BDT: 120, LKR: 300, NGN: 1500, KES: 130, TRY: 35, MXN: 18, BRL: 5, ZAR: 18, CNY: 7, HKD: 8, SEK: 10, NOK: 10, DKK: 7, PLN: 4, CZK: 23, AED: 3.7, SAR: 3.75, MYR: 4.5, ILS: 3.7, KWD: 0.3, BHD: 0.38 };
  const scale = (usd: string) => { const n = Number(usd) * (ROUGH[currency] ?? 1); return minorUnits(currency) === 0 ? String(Math.round(n)) : String(Math.round(n * 100) / 100); };
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
      {next && <><input type="hidden" name="next" value={next.next} /><input type="hidden" name="rail" value={next.rail} /></>}
      {initialLabel && !state?.errors && <div className="notice" style={{ marginBottom: 4 }}>Pre-filled from <strong>{initialLabel}</strong>. Change anything before issuing.</div>}
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
            <select id="currency" name="currency" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code} — {c.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="perTxnLimit">Per transaction ({currency})</label>
            <input id="perTxnLimit" name="perTxnLimit" type="number" min={step} step={step} required defaultValue={v("perTxnLimit", scale("25"))} aria-invalid={Boolean(err("perTxnLimit"))} />
          </div>
          <div className="field">
            <label htmlFor="dailyLimit">Per day ({currency})</label>
            <input id="dailyLimit" name="dailyLimit" type="number" min={step} step={step} required defaultValue={v("dailyLimit", scale("50"))} aria-invalid={Boolean(err("dailyLimit"))} />
            {err("dailyLimit") && <span className="hint" style={{ color: "var(--bad)" }}>{err("dailyLimit")}</span>}
          </div>
        </div>
        <div className="row">
          <div className="field">
            <label htmlFor="totalLimit">Total sanctioned</label>
            <input id="totalLimit" name="totalLimit" type="number" min={step} step={step} required defaultValue={v("totalLimit", scale("200"))} aria-invalid={Boolean(err("totalLimit"))} />
            <span className="hint">{err("totalLimit") ?? "Lifetime cap for this mandate. Issue a new one to renew."}</span>
          </div>
          <div className="field">
            <label htmlFor="approvalAbove">Ask me above</label>
            <input id="approvalAbove" name="approvalAbove" type="number" min="0" step={step} defaultValue={v("approvalAbove", scale("10"))} aria-invalid={Boolean(err("approvalAbove"))} />
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
        <legend>Escalation style</legend>
        <div className="row">
          <div className="field">
            <label htmlFor="vetoAbove">Veto window above</label>
            <input id="vetoAbove" name="vetoAbove" type="number" min="0" step={step} defaultValue={v("vetoAbove", "")} aria-invalid={Boolean(err("vetoAbove"))} placeholder="blank = off" />
            <span className="hint" style={err("vetoAbove") ? { color: "var(--bad)" } : undefined}>{err("vetoAbove") ?? "Approval by silence: above this (and below “ask me above”) you are told and the purchase goes through after the window unless you cancel. Nobody is woken up; you keep the right to stop it."}</span>
          </div>
          <div className="field">
            <label htmlFor="vetoMinutes">Veto window (minutes)</label>
            <input id="vetoMinutes" name="vetoMinutes" type="number" min="1" max="1440" step="1" defaultValue={v("vetoMinutes", "15")} aria-invalid={Boolean(err("vetoMinutes"))} />
            {err("vetoMinutes") && <span className="hint" style={{ color: "var(--bad)" }}>{err("vetoMinutes")}</span>}
          </div>
        </div>
        <div className="field">
          <label htmlFor="mode">Mode</label>
          <select id="mode" name="mode" defaultValue={v("mode", "enforce")}>
            <option value="enforce">Enforce — decline and escalate according to the terms</option>
            <option value="observe">Observe (shadow mode) — let everything through, record what the terms would have done</option>
          </select>
          <span className="hint">Observe for a few days to tune the terms against a working agent, then switch to enforce from the mandate page.</span>
        </div>
      </fieldset>

      <fieldset>
        <legend>Graduated autonomy</legend>
        <label className="check"><input type="checkbox" name="autonomyOn" defaultChecked={v("autonomyOn") === "on"} /> Let this mandate earn its limits</label>
        <div className="row-3">
          <div className="field">
            <label htmlFor="autonomyStep">Raise by ({currency})</label>
            <input id="autonomyStep" name="autonomyStep" type="number" min="0" step={step} defaultValue={v("autonomyStep", scale("5"))} aria-invalid={Boolean(err("autonomyStep"))} />
          </div>
          <div className="field">
            <label htmlFor="autonomyEvery">…every (clean decisions)</label>
            <input id="autonomyEvery" name="autonomyEvery" type="number" min="1" max="1000" step="1" defaultValue={v("autonomyEvery", "10")} aria-invalid={Boolean(err("autonomyEvery"))} />
          </div>
          <div className="field">
            <label htmlFor="autonomyCeiling">Up to a per-transaction limit of</label>
            <input id="autonomyCeiling" name="autonomyCeiling" type="number" min="0" step={step} defaultValue={v("autonomyCeiling", scale("100"))} aria-invalid={Boolean(err("autonomyCeiling"))} />
            <span className="hint" style={err("autonomyCeiling") ? { color: "var(--bad)" } : undefined}>{err("autonomyCeiling") ?? "The per-transaction limit and the ask-me-above threshold rise together; a denial or a decline burst steps them back."}</span>
          </div>
        </div>
      </fieldset>

      <fieldset>
        <legend>Holds</legend>
        <p className="muted" style={{ margin: "0 0 10px", fontSize: 13.5 }}>An approval is a hold, not a charge. After paying, the agent captures what it actually spent (less releases the difference) or voids the hold. If it does neither, the hold is closed for it when the time below runs out.</p>
        <div className="row">
          <div className="field">
            <label htmlFor="holdTtlHours">Holds stay open for (hours)</label>
            <input id="holdTtlHours" name="holdTtlHours" type="number" min="0" max="336" step="1" defaultValue={v("holdTtlHours", "24")} aria-invalid={Boolean(err("holdTtlHours"))} />
            <span className="hint" style={err("holdTtlHours") ? { color: "var(--bad)" } : undefined}>{err("holdTtlHours") ?? "0 settles every approval at once, as before. Up to 14 days."}</span>
          </div>
          <div className="field">
            <label htmlFor="holdPolicy">When a hold expires unsettled</label>
            <select id="holdPolicy" name="holdPolicy" defaultValue={v("holdPolicy", "capture")}>
              <option value="capture">Capture it in full — assume the money moved (safe default)</option>
              <option value="release">Release it — give the amount back to the limits</option>
            </select>
            <span className="hint">Release suits agents that always capture; capture suits agents you don't fully trust to report.</span>
          </div>
        </div>
      </fieldset>

      <fieldset>
        <legend>Card</legend>
        {stripeOn && cardProblem ? (
          <p className="muted" style={{ margin: 0 }}>A card can't be issued yet: {cardProblem} The mandate still works through the API, MCP and proxy.</p>
        ) : stripeOn ? (
          <>
            <label className="check"><input type="checkbox" name="issueCard" defaultChecked={state?.values ? v("issueCard") === "on" : true} /> Issue a Stripe virtual card bound to this mandate (real-time authorisation)</label>
            <span className="hint">Cards are issued in {cardCurrency} and paid from the workspace's prepaid balance; pick {cardCurrency} above.</span>
          </>
        ) : (
          <p className="muted" style={{ margin: 0 }}>Virtual cards are not enabled on this deployment yet, so no card will be issued. The mandate works through the API, MCP and the API-key proxy; when cards are switched on, issue a new mandate to get one.</p>
        )}
      </fieldset>

      <div className="actions">
        <button className="btn accent" type="submit" disabled={pending}>{pending ? "Issuing…" : "Issue mandate"}</button>
        <Link href="/" className="btn secondary">Cancel</Link>
      </div>
    </form>
  );
}
