export default function TermsPage() {
  const operator = process.env.LEGAL_OPERATOR_NAME ?? "the operator of this Mandate deployment";
  const contact = process.env.LEGAL_CONTACT_EMAIL ?? "the contact address in the page footer";
  return (
    <div className="legal">
      <div className="eyebrow">Legal</div>
      <h1>Terms of Service</h1>
      <p>Last updated 5 September 2026. These terms govern your use of Mandate as provided by {operator} ("we"). By creating an account you agree to them.</p>
      <h2>What Mandate is</h2>
      <p>Mandate lets you define spending authority ("mandates") for software agents, decides each agent request against those terms, notifies you when a decision is yours, and keeps a tamper-evident record. Mandate is a control and record-keeping tool. It is not a bank, a payment institution, a card issuer, or a financial adviser. Where a virtual card is offered, it is issued by Stripe under Stripe's terms.</p>
      <h2>Your responsibilities</h2>
      <p>You are responsible for the terms you set, for who you invite into a workspace and the roles you give them, for keeping your sign-in methods and agent credentials safe, and for the agents you connect. A decision made by an agent within the terms you set is your decision. Revoke a mandate the moment you no longer want an agent to act under it.</p>
      <h2>What we do not promise</h2>
      <p>Mandate decides requests that reach it. It cannot control spending that bypasses it (for example, an agent given your real card or key directly). The REST path relies on the agent reporting merchant and amount truthfully; the card and API-proxy paths enforce independently. Notifications depend on third-party services and may be delayed or fail; the inbox is authoritative.</p>
      <h2>Virtual cards and prepaid balance</h2>
      <p>Where virtual cards are enabled, they are issued by Stripe's partner bank under Stripe's cardholder terms, which you accept separately in Settings; {operator} operates the spending controls, not the card programme. Cards are paid for from a prepaid balance you add to a workspace by card payment. A top-up is credited in full once the payment settles; unspent balance is refundable on request to the original payment method (revoke the card mandates first so no holds are outstanding), less any amount a merchant has captured or is entitled to capture. A prepaid balance is not a deposit account, earns no interest, and is not insured. Card transactions are subject to the merchant's and the card network's rules on refunds and disputes; we will pass disputes to Stripe on your behalf but cannot guarantee their outcome. We may freeze or cancel a card, or decline a top-up, where we suspect fraud, sanctions exposure or misuse, and where the law requires us to. You must be at least 18 and provide accurate cardholder details; cards are issued only to residents of the countries this deployment supports.</p>
      <h2>Acceptable use</h2>
      <p>Do not use Mandate for anything unlawful, to evade your own or others' payment obligations, or to attack the service. We may suspend accounts that do.</p>
      <h2>Liability</h2>
      <p>To the extent permitted by law, the service is provided as is, and our liability to you is limited to the fees you paid us in the preceding twelve months (zero, while the service is free). Nothing here limits liability that cannot be limited by law.</p>
      <h2>Changes and termination</h2>
      <p>You can delete your account and workspaces at any time; your ledger export remains yours. We may change these terms with notice on this page; continued use after the change means acceptance.</p>
      <h2>Contact</h2>
      <p>Questions about these terms: {contact}.</p>
    </div>
  );
}
