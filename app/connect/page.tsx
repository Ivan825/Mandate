import Link from "next/link";
import { requireCtx, can } from "@/lib/session";
import { MCP_RESOURCE } from "@/lib/auth";
import { appUrl } from "@/lib/env";
import { getMandate, listMandates, revealToken } from "@/lib/service";
import { grantValid, sweepReveals } from "@/lib/reveal";
import { LiveCheck } from "./live";

export const metadata = { title: "Connect an agent" };

// The connect wizard: pick how the agent talks to Mandate, get the exact
// snippet (with the real token inside it while the show-once window is
// open), and watch the first call land. Each rail is a page, not a modal,
// so the URL can be shared with whoever is setting the agent up.

const RAILS = [
  { key: "claude", label: "Claude Desktop / claude.ai" },
  { key: "claude-code", label: "Claude Code" },
  { key: "cursor", label: "Cursor · Windsurf · any MCP client" },
  { key: "python", label: "Python" },
  { key: "typescript", label: "TypeScript / Node" },
  { key: "curl", label: "curl / any HTTP" },
  { key: "proxy", label: "OpenAI / Anthropic / Gemini SDK" },
] as const;
type Rail = (typeof RAILS)[number]["key"];

export default async function ConnectPage({ searchParams }: { searchParams: Promise<{ rail?: string; mandate?: string; g?: string }> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const rail: Rail = (RAILS.some((r) => r.key === sp.rail) ? sp.rail : "claude") as Rail;
  const base = appUrl();
  await sweepReveals();
  const mandates = await listMandates(ctx.workspaceId, true);
  const chosen = sp.mandate && /^[0-9a-f-]{36}$/i.test(sp.mandate) ? await getMandate(ctx.workspaceId, sp.mandate) : null;
  const token = chosen && grantValid(chosen.id, sp.g) ? await revealToken(ctx.workspaceId, chosen.id) : null;
  const TOKEN = token ?? "mnd_…your-token…";
  const mayIssue = await can({ mandate: ["issue"] });
  const q = (r: string) => `/connect?${new URLSearchParams({ rail: r, ...(sp.mandate ? { mandate: sp.mandate } : {}), ...(sp.g ? { g: sp.g } : {}) }).toString()}`;
  const tokenRail = rail === "python" || rail === "typescript" || rail === "curl";

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Connect an agent</div>
          <h1>Pick how your agent talks to Mandate</h1>
          <p className="muted">Every rail goes through the same policy engine and lands in the same ledger. The box on the right tells you the moment the first call arrives.</p>
        </div>
      </div>
      <nav className="rails" aria-label="Rails">{RAILS.map((r) => <Link key={r.key} href={q(r.key)} className={r.key === rail ? "on" : ""}>{r.label}</Link>)}</nav>

      <div className="grid-2" style={{ alignItems: "start", gridTemplateColumns: "minmax(0,3fr) minmax(0,2fr)" }}>
        <div className="stack">
          {tokenRail && (
            <div className="card">
              <div className="eyebrow">Mandate token</div>
              {token ? (
                <><p className="muted" style={{ margin: "4px 0 8px" }}>The snippets below carry the real token for <strong>{chosen!.name}</strong>. It is shown only now — copy the snippet before leaving this page.</p><div className="token">{token}</div></>
              ) : chosen ? (
                <p className="muted" style={{ margin: "4px 0 0" }}>The token for <strong>{chosen.name}</strong> was shown once when it was issued and is not stored. Paste it where the snippets say <code>mnd_…</code>, or <Link href={`/mandates/new?from=${chosen.id}`}>issue a fresh one</Link>.</p>
              ) : (
                <>
                  <p className="muted" style={{ margin: "4px 0 10px" }}>These rails use a mandate token, shown once when a mandate is issued. {mayIssue ? "Issue one and you'll come back here with the token filled in." : "Ask an owner or admin to issue one."}</p>
                  {mayIssue && <div className="actions"><Link className="btn accent" href={`/mandates/new?template=llm-dev&next=connect&rail=${rail}`}>Issue a mandate</Link>{mandates.length > 0 && <span className="faint" style={{ fontSize: 12.5 }}>or reuse a token you saved from: {mandates.slice(0, 4).map(({ m }) => m.name).join(", ")}</span>}</div>}
                </>
              )}
            </div>
          )}

          {rail === "claude" && (
            <div className="card stack">
              <h3>Claude Desktop or claude.ai</h3>
              <ol className="steps">
                <li>Settings → <strong>Connectors</strong> → <strong>Add custom connector</strong>.</li>
                <li>Name it <em>Mandate</em>; paste this URL:<pre>{MCP_RESOURCE}</pre></li>
                <li>Choose <strong>Sign in now</strong> and <strong>Use Claude's published identity</strong> (CIMD). If that option is missing, <em>Register automatically</em> also works.</li>
                <li>Claude sends you to Mandate's consent page: check the workspace, click <strong>Allow</strong>.</li>
                <li>Back in Claude, say: <em>“List my mandates, then request a $2 purchase at OpenAI for a test.”</em></li>
              </ol>
              <p className="faint" style={{ fontSize: 12.5 }}>Claude gets six tools: <code>list_mandates</code>, <code>check_mandate</code>, <code>request_purchase</code>, <code>capture_purchase</code>, <code>void_purchase</code>, <code>get_purchase</code>. Disconnect any time from Settings.</p>
            </div>
          )}
          {rail === "claude-code" && (
            <div className="card stack">
              <h3>Claude Code</h3>
              <pre>{`claude mcp add --transport http mandate ${MCP_RESOURCE}\n# then, inside Claude Code:\n/mcp   # → authenticate mandate → approve on the consent page`}</pre>
              <p className="muted">Then ask it to list mandates and request a small test purchase. For a machine without a browser, use the stdio server with a token instead (see <em>Cursor · any MCP client</em>).</p>
            </div>
          )}
          {rail === "cursor" && (
            <div className="card stack">
              <h3>Cursor, Windsurf, Codex, any MCP client</h3>
              <p className="muted">Remote server with OAuth (the client opens the consent page):</p>
              <pre>{`{\n  "mcpServers": {\n    "mandate": { "type": "http", "url": "${MCP_RESOURCE}" }\n  }\n}`}</pre>
              <p className="muted">Or the zero-dependency stdio server with a mandate token, for clients that cannot do OAuth:</p>
              <pre>{`{\n  "mcpServers": {\n    "mandate": {\n      "command": "node",\n      "args": ["/path/to/Mandate/mcp/server.mjs"],\n      "env": { "MANDATE_URL": "${base}", "MANDATE_TOKEN": "${TOKEN}" }\n    }\n  }\n}`}</pre>
            </div>
          )}
          {rail === "python" && (
            <div className="card stack">
              <h3>Python</h3>
              <pre>{`pip install mandate-agent`}</pre>
              <pre>{`from mandate_agent import Mandate

m = Mandate("${TOKEN}", base_url="${base}")

with m.hold(1299, "OpenAI", purpose="API credits", idempotency_key="order-1") as h:
    # h.decision is "approved" here (declined raises MandateDeclined with h.remedy;
    # pending waits for the owner, up to wait_for=... seconds, then raises MandatePending)
    pay_the_merchant()
    h.capture(1199)          # what was actually paid; the rest goes back to the limits
# leaving the block without capture() voids the hold; an exception voids it too`}</pre>
              <p className="muted">Agent frameworks: <code>from mandate_agent.tools import openai_tools, langchain_tools</code> gives ready-made tools (<code>request_purchase</code>, <code>capture_purchase</code>, <code>void_purchase</code>, <code>check_mandate</code>). Source and docs: <code>sdk/python</code> in the repo.</p>
            </div>
          )}
          {rail === "typescript" && (
            <div className="card stack">
              <h3>TypeScript / Node</h3>
              <pre>{`npm install mandate-agent`}</pre>
              <pre>{`import { Mandate } from "mandate-agent";

const m = new Mandate("${TOKEN}", { baseUrl: "${base}" });

const a = await m.authorize({ amount: 1299, merchant: "OpenAI", purpose: "API credits", idempotencyKey: "order-1" });
if (a.decision === "approved") {
  await payTheMerchant();
  await m.capture(a.transactionId, { amount: 1199 });   // or m.void(a.transactionId)
} else {
  console.log(a.decision, a.reason, a.remedy);            // when to retry, the most that would pass now
}`}</pre>
              <p className="muted">Vercel AI SDK: <code>import {"{ mandateTools }"} from "mandate-agent/ai"</code> → <code>tools: mandateTools(m)</code>. OpenAI function-calling definitions: <code>openaiTools(m)</code>. Source: <code>sdk/typescript</code>.</p>
            </div>
          )}
          {rail === "curl" && (
            <div className="card stack">
              <h3>Any HTTP client</h3>
              <pre>{`# 1. ask before paying (200 approved = a hold · 202 pending · 403 declined + remedy)
curl -X POST ${base}/api/agent/authorize \\
  -H "authorization: Bearer ${TOKEN}" -H "content-type: application/json" \\
  -H "idempotency-key: order-1" \\
  -d '{"amount":1299,"merchant":"OpenAI","purpose":"API credits"}'

# 2. after paying, say what was actually paid (or void)
curl -X POST ${base}/api/agent/capture \\
  -H "authorization: Bearer ${TOKEN}" -H "content-type: application/json" \\
  -d '{"transactionId":"<from step 1>","amount":1199}'

# what's left
curl ${base}/api/agent/mandate -H "authorization: Bearer ${TOKEN}"`}</pre>
            </div>
          )}
          {rail === "proxy" && (
            <div className="card stack">
              <h3>Meter an LLM SDK through a proxy key</h3>
              <ol className="steps">
                <li>On the <Link href="/proxy">API proxy</Link> page, store your provider key once and issue a proxy key bound to a USD mandate.</li>
                <li>Point the SDK at Mandate and change nothing else:</li>
              </ol>
              <pre>{`OPENAI_BASE_URL=${base}/api/proxy/openai        OPENAI_API_KEY=mpx_…
ANTHROPIC_BASE_URL=${base}/api/proxy/anthropic  ANTHROPIC_API_KEY=mpx_…
# Gemini: base URL ${base}/api/proxy/gemini with x-goog-api-key: mpx_…`}</pre>
              <p className="muted">Each call is priced from the request, pre-authorised, forwarded with the real key, and settled on the tokens the provider reports. A declined call comes back as the provider's own error shape with <code>x-mandate-rule</code> and <code>x-mandate-retry-at</code> headers.</p>
            </div>
          )}
        </div>
        <LiveCheck mandateId={chosen?.id ?? null} rail={rail} />
      </div>
    </>
  );
}
