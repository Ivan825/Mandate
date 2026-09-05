export default function DocsPage() {
  const base = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
  return (
    <div style={{ maxWidth: 760 }}>
      <div className="eyebrow">Agent API</div>
      <h1>How an agent spends under a mandate</h1>
      <p className="muted" style={{ margin: "8px 0 24px" }}>The agent never sees a card number or your account. It holds a mandate token and asks before each purchase. Three answers are possible, and each is written to the ledger.</p>

      <div className="stack">
        <div className="card">
          <h3>1. Ask before spending</h3>
          <pre>{`POST ${base}/api/agent/authorize
Authorization: Bearer mnd_...
Content-Type: application/json

{ "amount": 1299, "merchant": "OpenAI", "purpose": "API credits", "category": "computer_software_stores" }`}</pre>
          <p className="muted" style={{ marginTop: 10 }}>Amounts are integers in minor units (cents, paise). The response status is <code>200</code> approved, <code>403</code> declined, or <code>202</code> pending.</p>
          <pre>{`{ "decision": "approved", "reason": "Within all mandate limits.", "rule": "limits",
  "transactionId": "…", "remaining": { "today": 8701, "total": 48701, "todayDisplay": "$87.01" } }`}</pre>
        </div>

        <div className="card">
          <h3>2. When the answer is pending</h3>
          <p className="muted">The amount was above the owner's threshold. The request is in their inbox. The agent should tell the user, wait, and retry the identical request; once approved, the retry is approved and the allowance is consumed.</p>
          <pre>{`{ "decision": "pending", "rule": "approval", "approvalId": "…",
  "next": "Wait for the owner to approve, then retry the same request." }`}</pre>
        </div>

        <div className="card">
          <h3>3. Read the mandate first</h3>
          <pre>{`GET ${base}/api/agent/mandate
Authorization: Bearer mnd_...`}</pre>
          <p className="muted" style={{ marginTop: 10 }}>Returns limits, what's left today and overall, allowed merchants, active hours and expiry, so the agent can plan instead of learning its limits by being declined.</p>
        </div>

        <div className="card">
          <h3>Claude Code, Cursor and other MCP clients</h3>
          <p className="muted">The repo ships <code>mcp/server.mjs</code>, a stdio MCP server exposing two tools: <code>check_mandate</code> and <code>request_purchase</code>. Add it to your client with the mandate token in the environment and the agent gains a spending conscience without any code changes.</p>
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
          <h3>Stripe virtual cards</h3>
          <p className="muted">With <code>STRIPE_SECRET_KEY</code> set, issuing a mandate also issues a virtual card. Every card authorisation hits <code>/api/webhooks/stripe</code> in real time and is decided by the same policy engine as the API, so an agent that pays by card and an agent that pays by API are held to identical terms. Stripe's own spending limits are set as a second line of defence.</p>
        </div>
      </div>
    </div>
  );
}
