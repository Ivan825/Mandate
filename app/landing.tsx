import Link from "next/link";

// The public front door. Written for the person who runs agents and has
// felt the specific fear: the $50k token month, the wrong item bought, the
// key pushed to a branch. One thesis, one mechanism, one call to action.

export function Landing({ base, goodbye = false }: { base: string; goodbye?: boolean }) {
  return (
    <div className="landing">
      {goodbye && <div className="notice ok" style={{ margin: "24px 0 0" }}>Your account and its data were deleted. Thank you for trying Mandate.</div>}
      <section className="hero">
        <div className="eyebrow">For everyone who lets an agent spend</div>
        <h1>Give your agents a sanction, not a card.</h1>
        <p className="lede">An agent gets a mandate: how much, where, when, and the point above which it must ask you. Every purchase is decided against those terms and written to a ledger you can prove. Revoke in one tap.</p>
        <div className="actions">
          <Link href="/sign-in" className="btn accent">Start free</Link>
          <a href="#how" className="btn secondary">How it works</a>
        </div>
        <p className="faint" style={{ fontSize: 13, marginTop: 10 }}>No passwords. Works with Claude, ChatGPT, Cursor and anything that speaks MCP.</p>
      </section>

      <section className="three" id="how">
        <div>
          <div className="eyebrow">1 · Issue</div>
          <h3>Sanction terms, not secrets</h3>
          <p>Per-transaction, daily and total limits. Allowed merchants. Active hours. Expiry. An "ask me above" threshold. The agent never sees your card or your accounts.</p>
        </div>
        <div>
          <div className="eyebrow">2 · Connect</div>
          <h3>One click from your agent</h3>
          <p>Add <span className="mono">{base}/api/mcp</span> in Claude, ChatGPT or Cursor. The agent sends you to a consent screen and receives a scoped token. Your own code uses a REST token instead.</p>
        </div>
        <div>
          <div className="eyebrow">3 · Decide</div>
          <h3>Approve once, from wherever you are</h3>
          <p>Anything above the threshold pauses the agent and reaches every approver by email or webhook, with signed one-tap approve and deny links. Unanswered requests expire on their own.</p>
        </div>
      </section>

      <section className="proof">
        <div className="card">
          <div className="eyebrow">What the agent sees</div>
          <pre>{`request_purchase({ mandateId, amount: 4500, merchant: "Anthropic", purpose: "Top-up" })
→ { "decision": "pending", "reason": "Above the $20.00 threshold — needs your approval" }

… you tap Approve once …

request_purchase({ …same… })
→ { "decision": "approved", "rule": "allowance", "remaining": { "today": 801 } }`}</pre>
        </div>
        <div className="card">
          <div className="eyebrow">What you can prove afterwards</div>
          <p>Every grant, ask, allowance and refusal is an entry in a hash-chained ledger. Export it as a receipt: anyone can re-run the hashes, and an edited row breaks the chain from that point on.</p>
          <p>Cards too: with Stripe Issuing, each mandate can carry a virtual card whose every swipe is decided by the same terms in real time.</p>
        </div>
      </section>

      <section className="why">
        <h2>Why this exists</h2>
        <p>Agents are the first counterparty that spends money without a limit, a condition, or a record. Banks solved this for people decades ago with sanction letters, delegation matrices and exposure books. Mandate applies the same discipline to software that acts for you, without making you the one who reads every line.</p>
        <p>Open source, self-hostable, and built to be the neutral layer between any agent and any rail.</p>
        <div className="actions"><Link href="/sign-in" className="btn accent">Create your first mandate</Link><a href="https://github.com/Ivan825/Mandate" className="btn secondary">Source on GitHub</a></div>
      </section>

    </div>
  );
}
