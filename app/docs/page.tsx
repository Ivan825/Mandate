import { requireCtx } from "@/lib/session";
import { MCP_RESOURCE } from "@/lib/auth";
import { appUrl } from "@/lib/env";
import { stripeEnabled } from "@/lib/stripe";
import Link from "next/link";

export default async function DocsPage() {
  await requireCtx();
  const base = appUrl();
  return (
    <div style={{ maxWidth: 780 }}>
      <div className="eyebrow">Connect agents</div>
      <h1>Four ways an agent spends under a mandate</h1>
      <p className="muted" style={{ margin: "8px 0 24px" }}>Whichever way it connects, the agent never sees a card number or your accounts, every purchase is decided by the same policy engine, and every decision lands in your ledger.</p>

      <div className="stack">
        <div className="card">
          <h3>1. Connect with one click (MCP + OAuth) — Claude, ChatGPT, Cursor, and any MCP client</h3>
          <p className="muted" style={{ marginTop: 8 }}>Mandate is a remote MCP server. Add it in your agent's connectors or MCP settings using this URL; the agent will send you here to sign in and approve, and receives a scoped token automatically. Nothing to copy.</p>
          <pre>{MCP_RESOURCE}</pre>
          <p className="muted">The agent gets eight tools: <code>list_mandates</code>, <code>check_mandate</code>, <code>request_purchase</code>, then <code>capture_purchase</code> / <code>void_purchase</code> to settle what it actually paid, <code>get_purchase</code>, and <code>propose_plan</code> / <code>get_plan</code> to get a whole shopping list approved once. Scopes: <code>mandate:read</code> to see limits, <code>mandate:spend</code> to ask to spend. You can disconnect any agent from Settings.</p>
          <pre>{`# Claude Code
claude mcp add --transport http mandate ${MCP_RESOURCE}

# Cursor / Windsurf / others: add an MCP server of type "http" with the URL above.`}</pre>
        </div>

        <div className="card">
          <h3>2. Your own agent: the SDKs or the REST API with a mandate token</h3>
          <p className="muted" style={{ marginTop: 8 }}>For code you run yourself. The token is shown once when you issue a mandate. The <Link href="/connect">connect wizard</Link> fills it into these snippets for you and watches for the first call.</p>
          <pre>{`pip install mandate-agent          # Python: from mandate_agent import Mandate
npm install mandate-agent          # TypeScript: import { Mandate } from "mandate-agent"`}</pre>
          <p className="muted">Both give you <code>authorize</code> / <code>capture</code> / <code>void</code>, a hold helper that voids on error, polling for pending approvals, and ready-made tools for the OpenAI Agents SDK, LangChain and the Vercel AI SDK. Underneath is plain HTTP:</p>
          <pre>{`POST ${base}/api/agent/authorize
Authorization: Bearer mnd_...
Idempotency-Key: order-2026-09-05-001
Content-Type: application/json

{ "amount": 1299, "merchant": "OpenAI", "purpose": "API credits", "category": "computer_software_stores" }`}</pre>
          <p className="muted" style={{ marginTop: 10 }}>Amounts are integers in minor units. <code>200</code> approved, <code>403</code> declined with the rule, <code>202</code> pending — you've been notified; the agent retries the identical request after you approve. Repeating an <code>Idempotency-Key</code> returns the stored answer instead of deciding twice. Every non-approval carries a <code>remedy</code>: when the same request would pass (<code>retryAt</code>, also sent as <code>x-mandate-retry-at</code>), the most that would pass right now (<code>maxAmountNow</code>), and one sentence of advice.</p>
          <p className="muted" style={{ marginTop: 10 }}><strong>An approval is a hold.</strong> Once the purchase completes, tell Mandate what was actually paid; paying less gives the difference back to the limits. A hold nobody settles is closed by the mandate's policy (captured in full, or released) when its TTL runs out — 24 hours by default.</p>
          <p className="muted" style={{ marginTop: 10 }}><strong>Two more answers an agent can get.</strong> A pending with rule <code>veto</code> means the owner set a veto window: the purchase goes through by itself at <code>remedy.retryAt</code> unless they cancel — retry then. And for a multi-step task, propose a <strong>plan</strong> first: <code>POST /api/agent/plans</code> with the list of intended purchases; once the owner approves it, each item passes without asking.</p>
          <pre>{`POST ${base}/api/agent/plans       { "title": "Q4 tooling", "items": [{ "merchant": "OpenAI", "amount": 2000, "purpose": "credits" }] }
GET  ${base}/api/agent/plans/:id   # proposed | approved | denied | completed …
POST ${base}/api/agent/capture     { "transactionId": "…", "amount": 940, "note": "order #1234" }
POST ${base}/api/agent/void        { "transactionId": "…", "reason": "checkout failed" }
GET  ${base}/api/agent/transactions/:id                  # held | captured | voided | released
GET  ${base}/api/agent/mandate                           # limits, what's left, open holds`}</pre>
        </div>

        <div className="card">
          <h3>3. Meter LLM API spend with a proxy key (OpenAI, Anthropic, Gemini)</h3>
          <p className="muted" style={{ marginTop: 8 }}>Store your provider key once on the <Link href="/proxy">API proxy</Link> page and hand the agent a proxy key bound to a USD mandate. Point the SDK's base URL at Mandate and change nothing else: each call is priced from the request, pre-authorised against the mandate, forwarded with the real key, and settled on the tokens the provider reports. The agent never holds the real key, so it cannot spend past the mandate.</p>
          <pre>{`OPENAI_BASE_URL=${base}/api/proxy/openai      OPENAI_API_KEY=mpx_...
ANTHROPIC_BASE_URL=${base}/api/proxy/anthropic ANTHROPIC_API_KEY=mpx_...
# Gemini: base URL ${base}/api/proxy/gemini with x-goog-api-key: mpx_...`}</pre>
        </div>

        <div className="card">
          <h3>4. Local MCP for Claude Code / Cursor without OAuth</h3>
          <p className="muted" style={{ marginTop: 8 }}>The repo ships <code>mcp/server.mjs</code>, a zero-dependency stdio server that wraps the REST API with a mandate token. Useful offline or for a single machine.</p>
          <pre>{`{
  "mcpServers": {
    "mandate": {
      "command": "node",
      "args": ["/path/to/mandate/mcp/server.mjs"],
      "env": { "MANDATE_URL": "${base}", "MANDATE_TOKEN": "mnd_..." }
    }
  }
}`}</pre>
        </div>

        <div className="card">
          <h3>Event webhooks — for the systems around the agent</h3>
          <p className="muted" style={{ marginTop: 8 }}>Every ledger event (decisions, captures, approvals, revocations, member changes) can be pushed as signed JSON to your own endpoints, with retries and ordering per endpoint. Set them up under <Link href="/settings/webhooks">Settings → Event webhooks</Link>; verify <code>Mandate-Signature</code> with the secret shown once.</p>
        </div>

        <div className="card">
          <h3>Virtual cards</h3>
          {stripeEnabled() ? (
            <p className="muted" style={{ marginTop: 8 }}>Tick "virtual card" when issuing a mandate and the agent gets a card of its own, paid from your workspace's prepaid <Link href="/balance">balance</Link>. Every card authorisation hits Mandate in real time and is decided by the same terms, so an agent that pays by card and an agent that asks by API are held to identical limits. A pending decision declines the swipe and waits for your approval.</p>
          ) : (
            <p className="muted" style={{ marginTop: 8 }}>Not enabled on this deployment yet. When they are, a mandate can carry its own virtual card, decided by the same terms in real time; until then the three rails above cover API, MCP and LLM spend.</p>
          )}
        </div>
      </div>
    </div>
  );
}
