import Link from "next/link";
import { redirect } from "next/navigation";
import { emailEnabled } from "@/lib/mailer";
import { getCtx } from "@/lib/session";
import { safeNext } from "@/lib/safe-next";
import { SignInForm } from "./form";

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string; sent?: string; error?: string }> }) {
  const ctx = await getCtx();
  const { next: rawNext, sent, error } = await searchParams;
  const next = safeNext(rawNext);
  if (ctx) redirect(next);
  const google = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  const emailDelivery = emailEnabled() ? "email" : "console";
  return (
    <div className="signin">
      <div className="signin-copy">
        <div className="sec-n">Mandate</div>
        <h1>Give your agents a <em>limit</em>, not a card.</h1>
        <p>Sign in, issue a mandate from a template, connect the agent you already use. The first decision lands in your ledger a minute later.</p>
        <ul>
          <li><b>No passwords.</b> An email link, Google, or a passkey.</li>
          <li><b>Your own workspace.</b> Nothing is shared until you invite someone.</li>
          <li><b>Nothing to install.</b> Agents connect over MCP, a token, or a proxy URL.</li>
        </ul>
        <p className="faint" style={{ fontSize: 13 }}>Prefer to run it yourself? <a href="https://github.com/Ivan825/Mandate" rel="noopener">The source</a> is AGPL-3.0; <code>docker compose up</code> is the whole install.</p>
      </div>
      <div className="signin-card">
        <h2>Sign in</h2>
        <p className="muted" style={{ margin: "4px 0 16px" }}>No passwords. Use Google, a passkey, or a link sent to your email.</p>
        <SignInForm google={google} next={next} sent={Boolean(sent)} error={error ?? null} emailDelivery={emailDelivery} />
        <p className="faint" style={{ fontSize: 12.5, marginTop: 14 }}>By signing in you agree to the <Link href="/terms">Terms</Link> and <Link href="/privacy">Privacy policy</Link>. New accounts get a personal workspace; nothing is shared until you invite someone.</p>
      </div>
    </div>
  );
}
