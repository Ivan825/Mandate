import { redirect } from "next/navigation";
import { getCtx } from "@/lib/session";
import { SignInForm } from "./form";

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string; sent?: string; error?: string }> }) {
  const ctx = await getCtx();
  const { next: rawNext, sent, error } = await searchParams;
  // Same-origin paths only: "//evil.example" and "/\\evil" are absolute URLs to a browser.
  const next = rawNext && /^\/(?![\/\\])/.test(rawNext) ? rawNext : "/";
  if (ctx) redirect(next);
  const google = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  const emailDelivery = process.env.RESEND_API_KEY ? "email" : "console";
  return (
    <div style={{ maxWidth: 420, margin: "56px auto" }}>
      <div className="eyebrow">Mandate</div>
      <h1 style={{ margin: "6px 0 8px" }}>Sign in</h1>
      <p className="muted" style={{ marginBottom: 18 }}>No passwords. Use Google, a passkey, or a link sent to your email.</p>
      <SignInForm google={google} next={next} sent={Boolean(sent)} error={error ?? null} emailDelivery={emailDelivery} />
    </div>
  );
}
