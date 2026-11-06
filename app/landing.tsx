import Link from "next/link";
import { MCP_RESOURCE } from "@/lib/auth";
import { CopyLine } from "./copy";

// The public front door. Written for the person who runs agents and has
// felt the specific fear: the $50k token month, the wrong item bought, the
// key pushed to a branch. The structure is the one evidence-first product
// sites use: a claim, a live picture, the problem as a table, the mechanism
// as numbered sections, proof, where it runs, how to start.

const SOURCE = "https://github.com/Ivan825/Mandate";

export function Landing({ base, goodbye = false }: { base: string; goodbye?: boolean }) {
  const host = base.replace(/^https?:\/\//, "");
  return (
    <div className="landing">
      {goodbye && <div className="notice ok" style={{ margin: "24px 0 0" }}>Your account and its data were deleted. Thank you for trying Mandate.</div>}

      {/* ---- hero ---- */}
      <section className="hero">
        <div className="hero-pill"><span className="dot" aria-hidden />scoped spending authority for AI agents · open source · self-hosted or hosted</div>
        <CopyLine label="claude" text={`claude mcp add --transport http mandate ${MCP_RESOURCE}`} />
        <h1>Give your agents a <em>limit</em>,<br />not a card.</h1>
        <p className="lede">An agent gets a mandate: how much per purchase, per day and in total, which merchants, which hours, and the point above which it must ask you. Every request is decided against those terms before money moves, and every decision is written to a ledger you can prove. One button freezes everything.</p>
        <div className="actions">
          <Link href="/sign-in" className="btn accent">Start free</Link>
          <a href="#demo" className="btn secondary">Watch the demo</a>
          <a href={SOURCE} className="btn secondary" rel="noopener">Source on GitHub</a>
        </div>
        <div className="chips" aria-label="Ways an agent can spend under a mandate">
          <span>MCP · OAuth 2.1</span><span>REST token</span><span>Python SDK</span><span>TypeScript SDK</span><span>OpenAI · Anthropic · Gemini proxy</span><span>any API target</span><span>virtual cards</span><span>vouchers</span>
        </div>
      </section>

      {/* ---- stats ---- */}
      <section className="stats" aria-label="Numbers">
        <div><b>55 / 55</b><span>adversarial attempts stopped in the <a href="#proof">red-team run</a></span></div>
        <div><b>199</b><span>tests: engine, service layer against Postgres, a real browser through every flow</span></div>
        <div><b>0</b><span>cards, passwords or provider keys an agent ever holds</span></div>
        <div><b>1 tap</b><span>to approve, deny, or freeze every rail from your phone</span></div>
      </section>

      {/* ---- demo ---- */}
      <section className="demo" id="demo">
        <video controls playsInline preload="metadata" poster="/demo/poster.jpg" aria-label="Two-minute demo of Mandate: a mandate is issued, an agent is approved, declined and made to ask, the owner approves once, freezes everything, revokes a delegation, and the ledger is shown">
          <source src="/demo/mandate-demo.mp4" type="video/mp4" />
        </video>
        <p className="faint">Two minutes, narrated. A real agent against a real mandate: approved as a hold, declined off-list, held for a human, approved once, frozen, delegated, revoked — and all of it in the ledger.</p>
      </section>

      {/* ---- live board ---- */}
      <section className="board" aria-label="What a decision looks like">
        <div className="board-head"><span>research-assistant · $50 / purchase · $150 / day · ask above $20</span><span className="live"><i aria-hidden />live</span></div>
        <div className="board-rows">
          <div className="row"><span className="pill approved">approved</span><span className="who">$12.00 at OpenAI</span><span className="what">in scope · held · captured $11.00, $1.00 released</span></div>
          <div className="row"><span className="pill declined">declined</span><span className="who">$15.00 at Namecheap</span><span className="what">rule <code>merchant</code> · remedy: OpenAI, Anthropic or Vercel, or ask the owner to add it</span></div>
          <div className="row"><span className="pill pending">pending</span><span className="who">$35.00 at Anthropic</span><span className="what">above $20 · the owner has a one-tap link · retry after approval</span></div>
          <div className="row"><span className="pill frozen">frozen</span><span className="who">$5.00 at OpenAI</span><span className="what">the owner pressed Freeze all · every rail declines until unfrozen</span></div>
        </div>
        <div className="board-ticker">
          <span><b>agent</b> → authorize · 1200 · OpenAI · <i>limits</i></span>
          <span><b>owner</b> → approved once · 3500 · Anthropic</span>
          <span><b>agent</b> → delegate · “Price checker” · $10 / purchase · OpenAI only</span>
          <span><b>ledger</b> → #48 · hash a1f6d4… · anchored publicly</span>
        </div>
      </section>

      {/* ---- 01 the problem ---- */}
      <section className="sec" id="problem">
        <div className="sec-n">01 · The problem</div>
        <h2>Agents are the first counterparty that spends without a limit, a condition, or a record.</h2>
        <p className="sec-lede">Today the only way to let an agent buy something is to hand it your card or your API key. Then it holds <em>all</em> of your money, and you find out what it did from the statement. Spend caps on one provider cap that provider; they do not say which purchases, do not ask a human, do not cover the next vendor, and leave nothing an auditor could read.</p>
        <div className="tbl cmp">
          <table>
            <thead><tr><th></th><th>With a card or a key</th><th>With a mandate</th></tr></thead>
            <tbody>
              <tr><td>What the agent holds</td><td>Your card or your provider key — everything</td><td>A token scoped to one mandate, or an OAuth grant bound to one workspace</td></tr>
              <tr><td>How much it can spend</td><td>Whatever is on the card</td><td>Per purchase, per day, in total; at these merchants; in these hours; until this date</td></tr>
              <tr><td>Big purchases</td><td>Go through</td><td>Wait as a hold until a person taps approve — or two people, or a passkey</td></tr>
              <tr><td>A helper the agent spins up</td><td>Gets the same key</td><td>Gets a narrower sub-mandate whose spend counts against the parent; dies when the parent is revoked</td></tr>
              <tr><td>Something goes wrong</td><td>Cancel the card</td><td>One button freezes every rail; nothing is deleted; unfreeze puts it back</td></tr>
              <tr><td>What happened</td><td>The statement, later</td><td>Every decision in a hash-chained ledger, signed and anchored publicly every day</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* ---- 02 what it is ---- */}
      <section className="sec band" id="what">
        <div className="band-in">
          <div className="sec-n">02 · What Mandate is</div>
          <h2>Authority to spend, as a thing you issue, narrow, share and revoke.</h2>
          <p className="sec-lede">Mandate is the layer between an agent and money. It is not a bank and not another agent: it decides, records, and asks. Four things, together, that a budget alert or a provider cap does not do.</p>
          <div className="four">
            <div><div className="k">01</div><h3>Scoped</h3><p>Limits, merchants, categories, hours, expiry and an ask-me-above threshold — enforced in a fixed order on every request, from every rail, by one policy engine.</p></div>
            <div><div className="k">02</div><h3>Human where it matters</h3><p>Above the threshold the agent waits. Approvals arrive as one-tap links by email, push or webhook; an approval is for that amount at that merchant, once. Large asks can require two to five named approvers, or a passkey.</p></div>
            <div><div className="k">03</div><h3>Holds, not charges</h3><p>An approval authorises; the agent captures what it actually spent and the rest goes back. A hold expires on its own. Merchants can redeem a signed voucher without an account, once, for at most what was authorised.</p></div>
            <div><div className="k">04</div><h3>A record you can prove</h3><p>Every grant, ask, allowance and refusal is a row in a hash-chained ledger. Receipts verify offline against a published key; the head is signed into a public anchor chain daily, so even the operator cannot rewrite history unnoticed.</p></div>
          </div>
        </div>
      </section>

      {/* ---- 03 how it works ---- */}
      <section className="sec" id="how">
        <div className="sec-n">03 · How it works</div>
        <h2>Issue, connect, ask, decide, settle, record.</h2>
        <p className="sec-lede">One request, six steps, each of them an event you can read later.</p>
        <ol className="steps">
          <li><div className="k">01</div><h3>Issue</h3><p>The owner writes the terms: $50 a purchase, $150 a day, OpenAI and Anthropic, ask above $20, until the end of the quarter. The agent gets a token that only works inside them.</p><code>mandate issued · research-assistant · USD · expires 06 Dec</code></li>
          <li><div className="k">02</div><h3>Connect</h3><p>Add the MCP server in Claude, Cursor or any MCP client and consent once; or put the token in the SDK; or point an OpenAI/Anthropic/Gemini SDK at the proxy and change nothing else.</p><code>claude mcp add --transport http mandate {host}/api/mcp</code></li>
          <li><div className="k">03</div><h3>Ask</h3><p>Before paying, the agent sends the amount, the merchant and a purpose. Retries carry an idempotency key, so a flaky network never decides twice.</p><code>POST /api/agent/authorize {"{"} amount: 1200, merchant: "OpenAI" {"}"}</code></li>
          <li><div className="k">04</div><h3>Decide</h3><p>frozen → paused → status → expiry → hours → merchant → category → per-purchase → daily → total → balance → every ancestor → plan → escalation. Approved as a hold, declined with the rule and a remedy, or pending a person.</p><code>200 approved · rule limits · hold until 09:28 tomorrow</code></li>
          <li><div className="k">05</div><h3>Settle</h3><p>The agent captures what it spent, or voids; a merchant redeems a voucher; a card authorisation is reconciled from Stripe; an expired hold closes by the mandate's policy.</p><code>captured 1100 · released 100</code></li>
          <li><div className="k">06</div><h3>Record</h3><p>Every step is a ledger row whose hash covers the one before it. Export a signed receipt; anyone can re-run the hashes. The head is anchored publicly once a day.</p><code>ledger #48 · hash a1f6d4… · anchor #31</code></li>
        </ol>
      </section>

      {/* ---- 04 every rail ---- */}
      <section className="sec band" id="rails">
        <div className="band-in">
          <div className="sec-n">04 · Every rail, one engine</div>
          <h2>However the agent pays, the same terms decide.</h2>
          <div className="railgrid">
            <div><h3>MCP + OAuth 2.1</h3><p>Claude, ChatGPT, Cursor, Windsurf, Claude Code. Nine tools: list, check, request, capture, void, get, propose a plan, get a plan, delegate. The grant is bound to one workspace and re-checks the member's role on every call.</p></div>
            <div><h3>REST token + SDKs</h3><p>Plain HTTP with a <code>mnd_</code> token, or <code>pip install mandate-agent</code> / <code>npm install mandate-agent</code> with ready-made tools for the OpenAI Agents SDK, LangChain and the Vercel AI SDK.</p></div>
            <div><h3>LLM proxy</h3><p>Point the OpenAI, Anthropic or Gemini SDK at <code>{host}/api/proxy/…</code> with a proxy key. Every call is priced before it is forwarded and settled on reported usage; your real provider key never leaves the server.</p></div>
            <div><h3>Any API target</h3><p>Register any https API with its credential injected in a header, priced per call or from the response. The agent gets a key bound to that target and nothing else.</p></div>
            <div><h3>Virtual cards</h3><p>With Stripe Issuing, each mandate can carry a card whose every swipe is decided by the same terms in real time, including incremental authorisations, against a prepaid balance.</p></div>
            <div><h3>Vouchers</h3><p>An approved hold can be presented to a merchant as a signed voucher (<code>mv1.…</code>, Ed25519) they verify offline and redeem once, for at most the authorised amount.</p></div>
          </div>
        </div>
      </section>

      {/* ---- 05 when it says no ---- */}
      <section className="sec" id="no">
        <div className="sec-n">05 · When it says no</div>
        <h2>A refusal names the rule it broke and what would pass.</h2>
        <div className="two">
          <div>
            <p className="sec-lede">An agent that is told only “no” loops. Every non-approval carries a <code>remedy</code>: when the same request would pass, the most that would pass right now, and one sentence of advice the agent can act on. Pending answers are never cached, so the retry after approval goes through.</p>
            <div className="chips rules" aria-label="Rules, in the order they are checked">
              <span>frozen</span><span>paused</span><span>status</span><span>expiry</span><span>hours</span><span>merchant</span><span>category</span><span>per_txn</span><span>daily</span><span>total</span><span>balance</span><span>parent_*</span><span>plan</span><span>approval</span><span>veto</span><span>allowance</span>
            </div>
          </div>
          <pre className="json">{`HTTP 403
{
  "decision": "declined",
  "rule": "daily",
  "reason": "Today's limit of $150.00 has $18.00 left.",
  "remedy": {
    "retryAt": "2026-11-07T00:00:00Z",
    "maxAmountNow": 1800,
    "approvalRequired": false,
    "message": "Up to $18.00 passes now; the day resets at midnight UTC."
  },
  "remaining": { "today": 1800, "total": 48200, "perTransaction": 5000 }
}`}</pre>
        </div>
      </section>

      {/* ---- 06 controls ---- */}
      <section className="sec band" id="controls">
        <div className="band-in">
          <div className="sec-n">06 · Controls for the owner</div>
          <h2>Built for the person who answers for the money.</h2>
          <div className="ctrl">
            <div><h3>Panic button</h3><p>Two clicks freeze every rail in the workspace. The engine checks it before it even loads the mandate. Nothing is revoked.</p></div>
            <div><h3>Co-signing</h3><p>Above a threshold, two to five distinct approvers must sign; one denial ends it; signatures are counted per account, not per e-mail spelling.</p></div>
            <div><h3>Routing</h3><p>Send requests to the right deciders by amount band, category, merchant or mandate; the route is recorded on the request.</p></div>
            <div><h3>Veto windows</h3><p>Let a purchase through by itself after a delay unless someone cancels it — for the ones you want to see, not sign.</p></div>
            <div><h3>Plans</h3><p>An agent proposes a shopping list; you approve it once; each item passes exactly once at its named merchant.</p></div>
            <div><h3>Sub-mandates</h3><p>An agent carves narrower mandates for helpers, three levels deep; the family's spend counts against every ancestor; revoking the parent revokes them all.</p></div>
            <div><h3>Disputes</h3><p>Contest any decision from its row; the mandate can pause; settle it as refunded, upheld or withdrawn — the limits net down accordingly.</p></div>
            <div><h3>Shadow mode</h3><p>Observe before enforcing: nothing is declined, every verdict is recorded, the report shows what would have happened. Hard rules still hold.</p></div>
            <div><h3>Time-travel</h3><p>Replay a mandate's real history against hypothetical terms and see which past decisions would change before you tighten anything.</p></div>
            <div><h3>Graduated autonomy</h3><p>Clean decisions raise the limits step by step towards a ceiling you set; a denial steps back.</p></div>
            <div><h3>Passkey-signed approvals</h3><p>A receipt can prove a person on a registered device decided — not a script with a cookie.</p></div>
            <div><h3>Sandboxes</h3><p><code>mnd_test_</code> tokens for CI: same engine, no cards or proxy keys, excluded from the books, reset in one click.</p></div>
          </div>
        </div>
      </section>

      {/* ---- 07 proof ---- */}
      <section className="sec" id="proof">
        <div className="sec-n">07 · Proof</div>
        <h2>Tested the way an attacker would use it.</h2>
        <div className="two">
          <div>
            <p className="sec-lede"><code>npm run redteam</code> plays a misbehaving agent against a running instance over plain HTTP: over its limits, off its merchant list, salami-slicing the day, forging an approval link, replaying an allowance, widening a delegation, settling someone else's hold, editing a voucher. Each attempt is checked for one thing — did a capturable authorisation come out?</p>
            <p className="sec-lede">Three suites run on every push: 22 engine tests, 41 integration tests against Postgres, 136 checks in a real browser. The security review — threat model, every finding, every fix, what is still open — is public.</p>
            <div className="links">
              <a href={`${SOURCE}/blob/main/docs/RED-TEAM.md`} rel="noopener">Red-team results →</a>
              <a href={`${SOURCE}/blob/main/docs/SAFETY-CASE.md`} rel="noopener">Safety case →</a>
              <a href={`${SOURCE}/blob/main/docs/SECURITY-AUDIT.md`} rel="noopener">Security audit →</a>
              <Link href="/anchors">Public anchors →</Link>
            </div>
          </div>
          <div className="proof-card">
            <div className="big"><b>55</b> attempts · <b>55</b> stopped</div>
            <ul>
              <li><span className="pill declined">403</span> one cent over the per-purchase limit</li>
              <li><span className="pill declined">403</span> “OpenAI Marketplace Reseller” against an allow-list of “OpenAI”</li>
              <li><span className="pill declined">403</span> a forged one-tap link; the real link, replayed</li>
              <li><span className="pill pending">202</span> an allowance reused for a different amount, merchant, or twice</li>
              <li><span className="pill declined">404</span> another mandate's token voiding this hold</li>
              <li><span className="pill declined">409</span> capturing a hold after its voucher was handed out</li>
              <li><span className="pill declined">400</span> a sub-mandate wider than its parent, or that never asks</li>
              <li><span className="pill declined">422</span> the same idempotency key with a bigger purchase</li>
              <li><span className="pill declined">403</span> a valid allowance while the workspace is frozen</li>
              <li><span className="pill approved">ok</span> the ledger chain verifies end to end afterwards</li>
            </ul>
          </div>
        </div>
      </section>

      {/* ---- 08 your machines ---- */}
      <section className="sec band" id="selfhost">
        <div className="band-in">
          <div className="sec-n">08 · Your machines, your data</div>
          <h2>Run the hosted beta, or run it yourself.</h2>
          <p className="sec-lede">AGPL-3.0. One Next.js app and one Postgres. Nothing leaves your deployment except the calls your agents make to the merchants and providers you chose, with your keys.</p>
          <div className="four">
            <div><h3>Keys stay encrypted</h3><p>Provider keys, target credentials and webhook secrets are AES-256-GCM under a key held outside the database; mandate and proxy tokens are stored only as hashes and shown once.</p></div>
            <div><h3>Egress is pinned</h3><p>Webhooks and API targets must be on the public internet; the DNS answer that passed the check is the address connected to, redirects are not followed, time and size are capped.</p></div>
            <div><h3>Fails closed</h3><p>If Mandate is down, nothing can be authorised. There is no mode in which an agent spends because the safeguard was unavailable.</p></div>
            <div><h3>Verifiable from outside</h3><p>Receipts verify against a published key; the anchor chain at <Link href="/anchors">/anchors</Link> lets anyone check that a ledger was not rebuilt after the fact.</p></div>
          </div>
        </div>
      </section>

      {/* ---- 09 get started ---- */}
      <section className="sec" id="start">
        <div className="sec-n">09 · Get started</div>
        <h2>Three ways in. All of them end at the same engine.</h2>
        <div className="start">
          <div>
            <h3>The hosted beta</h3>
            <p>Sign in with an email link, Google or a passkey. Issue a mandate from a template, connect an agent, approve from your phone. Free.</p>
            <Link href="/sign-in" className="btn accent">Start free</Link>
          </div>
          <div>
            <h3>From Claude, Cursor or any MCP client</h3>
            <p>Add the server, consent once on the page it sends you to, and ask the agent to <em>“request a $5 purchase at OpenAI”</em>.</p>
            <CopyLine label="mcp" text={MCP_RESOURCE} prompt="" />
          </div>
          <div>
            <h3>On your own machine</h3>
            <p>Postgres and the app on <code>localhost:3000</code>, migrations applied, sign-in links printed to the terminal.</p>
            <CopyLine label="shell" text={`git clone ${SOURCE} && cd Mandate && docker compose up`} />
          </div>
        </div>
        <p className="faint" style={{ marginTop: 18 }}>Full instructions, the REST reference and the SDK snippets are in the <Link href="/docs">docs</Link>; deployment to Vercel, Docker, AWS and ECS is in <a href={`${SOURCE}/blob/main/DEPLOY.md`} rel="noopener">DEPLOY.md</a>.</p>
      </section>

      {/* ---- close ---- */}
      <section className="close">
        <h2>The agent gets a limit. You get the record.</h2>
        <p>Issue a mandate in a minute, connect the agent you already use, and watch the first decision land in the ledger.</p>
        <div className="actions"><Link href="/sign-in" className="btn accent">Start free</Link><a href={SOURCE} className="btn secondary" rel="noopener">Read the source</a></div>
      </section>
    </div>
  );
}
