import Link from "next/link";
import { listAgents } from "@/lib/service";
import { stripeEnabled } from "@/lib/stripe";
import { createMandateAction } from "@/app/actions";

export default async function NewMandatePage({ searchParams }: { searchParams: Promise<{ agent?: string }> }) {
  const { agent } = await searchParams;
  const agents = await listAgents();
  const stripeOn = stripeEnabled();
  if (agents.length === 0) {
    return (
      <div style={{ maxWidth: 560 }}>
        <h1>Add an agent first</h1>
        <p className="muted" style={{ margin: "8px 0 16px" }}>A mandate is issued to an agent. <Link href="/agents/new">Create one</Link> and you'll come straight back here.</p>
      </div>
    );
  }
  return (
    <div style={{ maxWidth: 680 }}>
      <div className="eyebrow">Issue mandate</div>
      <h1>Sanction terms for this agent</h1>
      <p className="muted" style={{ margin: "8px 0 20px" }}>Think of it as a sanction letter: how much, per transaction and per day, where it may be spent, when, and the point above which you want to be asked. The agent receives a token that only works within these terms.</p>

      <form action={createMandateAction} className="form">
        <fieldset>
          <legend>Principal</legend>
          <div className="row">
            <div className="field">
              <label htmlFor="agentId">Agent</label>
              <select id="agentId" name="agentId" defaultValue={agent ?? agents[0].id} required>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="name">Mandate name</label>
              <input id="name" name="name" required placeholder="e.g. Dev tooling, Sept 2026" />
            </div>
          </div>
        </fieldset>

        <fieldset>
          <legend>Limits</legend>
          <div className="row-3">
            <div className="field">
              <label htmlFor="currency">Currency</label>
              <select id="currency" name="currency" defaultValue="USD">
                <option value="USD">USD</option><option value="INR">INR</option><option value="EUR">EUR</option><option value="GBP">GBP</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="perTxnLimit">Per transaction</label>
              <input id="perTxnLimit" name="perTxnLimit" type="number" min="0.01" step="0.01" required defaultValue="50" />
            </div>
            <div className="field">
              <label htmlFor="dailyLimit">Per day</label>
              <input id="dailyLimit" name="dailyLimit" type="number" min="0.01" step="0.01" required defaultValue="100" />
            </div>
          </div>
          <div className="row">
            <div className="field">
              <label htmlFor="totalLimit">Total sanctioned</label>
              <input id="totalLimit" name="totalLimit" type="number" min="0.01" step="0.01" required defaultValue="500" />
              <span className="hint">Lifetime cap for this mandate. Issue a new one to renew.</span>
            </div>
            <div className="field">
              <label htmlFor="approvalAbove">Ask me above</label>
              <input id="approvalAbove" name="approvalAbove" type="number" min="0" step="0.01" defaultValue="20" />
              <span className="hint">Leave blank to never escalate. Above this, the agent is paused until you approve in the inbox.</span>
            </div>
          </div>
        </fieldset>

        <fieldset>
          <legend>Scope</legend>
          <div className="row">
            <div className="field">
              <label htmlFor="allowedMerchants">Allowed merchants</label>
              <textarea id="allowedMerchants" name="allowedMerchants" placeholder={"OpenAI\nAnthropic\nVercel*\n(blank = any merchant)"} />
              <span className="hint">One per line. A trailing * matches a prefix. Blank means any merchant.</span>
            </div>
            <div className="field">
              <label htmlFor="blockedCategories">Blocked categories</label>
              <textarea id="blockedCategories" name="blockedCategories" defaultValue={"gambling\ncrypto\ncash_advance"} />
              <span className="hint">Stripe MCC category slugs, one per line.</span>
            </div>
          </div>
          <div className="row-3">
            <div className="field">
              <label htmlFor="activeHoursStart">Active from (hour)</label>
              <input id="activeHoursStart" name="activeHoursStart" type="number" min="0" max="23" defaultValue="0" />
            </div>
            <div className="field">
              <label htmlFor="activeHoursEnd">Active until (hour)</label>
              <input id="activeHoursEnd" name="activeHoursEnd" type="number" min="1" max="24" defaultValue="24" />
              <span className="hint">0 to 24 = all day. 8 to 23 blocks night-time spending.</span>
            </div>
            <div className="field">
              <label htmlFor="timezone">Timezone</label>
              <select id="timezone" name="timezone" defaultValue="Asia/Kolkata">
                <option>Asia/Kolkata</option><option>America/New_York</option><option>America/Los_Angeles</option><option>Europe/London</option><option>UTC</option>
              </select>
            </div>
          </div>
          <div className="field" style={{ maxWidth: 260 }}>
            <label htmlFor="expiresAt">Expires on</label>
            <input id="expiresAt" name="expiresAt" type="date" />
          </div>
        </fieldset>

        <fieldset>
          <legend>Card</legend>
          {stripeOn ? (
            <label className="check"><input type="checkbox" name="issueCard" defaultChecked /> Issue a Stripe virtual card bound to this mandate (real-time authorisation)</label>
          ) : (
            <p className="muted" style={{ margin: 0 }}>Stripe Issuing is not configured, so no card will be issued. The mandate still works through the agent API and simulation. Add <code>STRIPE_SECRET_KEY</code> to enable virtual cards.</p>
          )}
        </fieldset>

        <div className="actions">
          <button className="btn accent" type="submit">Issue mandate</button>
          <Link href="/" className="btn secondary">Cancel</Link>
        </div>
      </form>
    </div>
  );
}
