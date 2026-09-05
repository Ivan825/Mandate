import { requireCtx } from "@/lib/session";
import { MCP_RESOURCE } from "@/lib/auth";

export default async function DocsPage() {
  await requireCtx();
  const base = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
  return (
    <div style={{ maxWidth: 780 }}>
      <div className="eyebrow">Connect agents</div>
      <h1>Three ways an agent spends under a mandate</h1>
      <p className="muted" style={{ margin: "8px 0 24px" }}>Whichever way it connects, the agent never sees a card number or your accounts, every purchase is decided by the same policy engine, and every decision lands in your ledger.</p>

      <div className="stack">
        <div className="card">
          <h3>1. Connect with one click (MCP + OAuth) — Claude, ChatGPT, Cursor, and any MCP client</h3>
          <p className="muted" style={{ marginTop: 8 }}>Mandate is a remote MCP server. Add it in your agent's connectors or MCP settings using this URL; the agent will send you here to sign in and approve, and receives a scoped token automatically. Nothing to copy.</p>
          <pre>{MCP_RESOURCE}</pre>
          <p className="muted">The agent gets three tools: <code>list_mandates</code>, <code>check_mandate</code> and <code>request_purchase</code>. Scopes: <code>mandate:read</code> to see limits, <code>mandate:spend</code> to ask to spend. You can disconnect any agent from Settings.</p>
          <pre>{`# Claude Code
claude mcp add --transport http mandate ${MCP_RESOURCE}

# Cursor / Windsurf / others: add an MCP server of type "http" with the URL above.`}</pre>
        </div>

        <div className="card">
          <h3>2. Your own agent: the REST API with a mandate token</h3>
          <p className="muted" style={{ marginTop: 8 }}>For code you run yourself. The token is shown once when you issue a mandate.</p>
          <pre>{`POST ${base}/api/agent/authorize
Authorization: Bearer mnd_...
Idempotency-Key: order-2026-09-05-001
Content-Type: application/json

{ "amount": 1299, "merchant": "OpenAI", "purpose": "API credits", "category": "computer_software_stores" }`}</pre>
          <p className="muted" style={{ marginTop: 10 }}>Amounts are integers in minor units. <code>200</code> approved, <code>403</code> declined with the rule, <code>202</code> pending — you've been notified; the agent retries the identical request after you approve. Repeating an <code>Idempotency-Key</code> returns the stored answer instead of deciding twice.</p>
          <pre>{`GET ${base}/api/agent/mandate        # limits and what's left`}</pre>
        </div>

        <div className="card">
          <h3>3. Local MCP for Claude Code / Cursor without OAuth</h3>
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
          <h3>Virtual cards (Stripe Issuing)</h3>
          <p className="muted" style={{ marginTop: 8 }}>With Stripe configured, issuing a mandate also issues a virtual card. Every card authorisation hits Mandate in real time and is decided by the same terms, so an agent that pays by card and an agent that asks by API are held to identical limits. A pending decision declines the swipe and waits for your approval.</p>
        </div>
      </div>
    </div>
  );
}
