export default function PrivacyPage() {
  const operator = process.env.LEGAL_OPERATOR_NAME ?? "the operator of this Mandate deployment";
  const contact = process.env.LEGAL_CONTACT_EMAIL ?? "the contact address in the page footer";
  return (
    <div className="legal">
      <div className="eyebrow">Legal</div>
      <h1>Privacy Policy</h1>
      <p>Last updated 5 September 2026. This policy explains what {operator} ("we") collects when you use Mandate and why.</p>
      <h2>What we collect</h2>
      <ul>
        <li><strong>Account</strong>: your email address, name and profile image from Google if you sign in with Google, passkey public keys if you add a passkey. Never a password.</li>
        <li><strong>Workspace data</strong>: agents, mandates (limits, merchants, hours), purchase requests made by your agents (amount, merchant, purpose), approvals and denials, and the ledger that records them.</li>
        <li><strong>Notification channels</strong> you add: an email address or a webhook URL.</li>
        <li><strong>Connected agents</strong>: the OAuth clients you authorised and the scopes you granted.</li>
        <li><strong>Provider keys</strong> you store for the API proxy, encrypted at rest with a key held outside the database.</li>
        <li><strong>Technical</strong>: request logs with timestamps, IP addresses and identifiers needed to operate rate limits and investigate abuse, kept for a limited period.</li>
      </ul>
      <h2>Why</h2>
      <p>To run the service you asked for: decide requests, notify approvers, keep the record, and let you connect agents. We do not sell personal data and do not use it for advertising.</p>
      <h2>Who else sees it</h2>
      <p>Processors we rely on to run the service: our hosting and database providers, an email delivery provider for sign-in links and alerts, the webhook destinations you configure, Google Fonts (your browser fetches the typefaces from Google, which sees your IP address), and Stripe if virtual cards are enabled — Stripe holds the cardholder identity details you enter and the card itself, under its own privacy terms, and keeps them after you delete your account where card-programme rules require. Each receives only what its function needs. Agents you connect see the mandates in your workspace and the decisions on their own requests.</p>
      <h2>Your choices</h2>
      <p>Disconnect an agent, remove a channel, revoke a mandate, leave a workspace, or delete your account at any time from Settings. You can export your ledger. Google sign-in uses only your basic profile; you can revoke Mandate's access in your Google account.</p>
      <h2>Retention and security</h2>
      <p>Workspace data is kept while the workspace exists. The ledger is append-only by design; deleting a workspace deletes its ledger. Agent credentials are stored hashed; provider keys are stored encrypted; sessions are signed. Report a security concern to {contact}.</p>
      <h2>Contact</h2>
      <p>{contact}.</p>
    </div>
  );
}
