import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { countPending } from "@/lib/service";
import { configProblems } from "@/lib/db";
import { getCtx } from "@/lib/session";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { signOutAction, switchWorkspaceAction } from "./actions";
import { WorkspaceSwitcher } from "./switcher";
import { ThemeToggle, type Theme } from "./theme";
import { stripeEnabled } from "@/lib/stripe";
import { isOperator } from "@/lib/env";
import { cookies } from "next/headers";

const description = "Give your AI agents a sanction, not a card: per-transaction, daily and lifetime limits, merchant scope, hours, and a human in the loop above a threshold — enforced on every purchase and written to a signed ledger.";
export const metadata: Metadata = {
  title: { default: "Mandate", template: "%s · Mandate" },
  description,
  metadataBase: (() => { try { return new URL(process.env.APP_URL ?? process.env.BETTER_AUTH_URL ?? "http://localhost:3000"); } catch { return undefined; } })(),
  openGraph: { title: "Mandate — spending authority for AI agents", description, type: "website", siteName: "Mandate" },
  twitter: { card: "summary", title: "Mandate — spending authority for AI agents", description },
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getCtx();
  let pending = 0;
  let orgs: { id: string; name: string }[] = [];
  if (ctx) {
    try { pending = await countPending(ctx.workspaceId); } catch { /* db not ready yet */ }
    try { orgs = (await auth.api.listOrganizations({ headers: await headers() })).map((o) => ({ id: o.id, name: o.name })); } catch { /* ignore */ }
  }
  const problems = configProblems();
  const rawTheme = (await cookies()).get("theme")?.value;
  const theme: Theme = rawTheme === "light" || rawTheme === "dark" ? rawTheme : "system";
  return (
    <html lang="en" data-theme={theme === "system" ? undefined : theme} suppressHydrationWarning>
      <head>
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,600;8..60,700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" />
      </head>
      <body>
        <div className="topbar">
          <div className="topbar-in">
            <Link href="/" className="brand"><span className="mark" aria-hidden /> Mandate</Link>
            {ctx && (
              <nav className="nav">
                <Link href="/">Exposure</Link>
                <Link href="/approvals">Approvals{pending > 0 && <span className="badge">{pending}</span>}</Link>
                <Link href="/ledger">Ledger</Link>
                <Link href="/stats">Stats</Link>
                <Link href="/proxy">API proxy</Link>
                {stripeEnabled() && <Link href="/balance">Balance</Link>}
                <Link href="/members">Members</Link>
                <Link href="/docs">Connect agents</Link>
                <Link href="/settings">Settings</Link>
              </nav>
            )}
            <div className="spacer" />
            {ctx ? (
              <>
                <WorkspaceSwitcher current={ctx.workspaceId} orgs={orgs} action={switchWorkspaceAction} />
                {(ctx.role === "owner" || ctx.role === "admin") && <Link href="/mandates/new" className="btn accent sm">Issue mandate</Link>}
                <form action={signOutAction}><button className="btn secondary sm" type="submit" title={ctx.email}>Sign out</button></form>
              </>
            ) : (
              <Link href="/sign-in" className="btn secondary sm">Sign in</Link>
            )}
            <ThemeToggle initial={theme} />
          </div>
        </div>
        <main className="main">
          {problems.length > 0 && isOperator(ctx?.email) && <div className="notice bad" style={{ marginBottom: 20 }}><strong>Configuration problem (shown to operators only).</strong> {problems.join(" ")}</div>}
          {children}
        </main>
        <footer className="sitefoot">
          <div className="sitefoot-in">
            <span>Mandate</span>
            <Link href="/terms">Terms</Link>
            <Link href="/privacy">Privacy</Link>
            <Link href="/docs">Connect agents</Link>
            {process.env.LEGAL_CONTACT_EMAIL && <a href={`mailto:${process.env.LEGAL_CONTACT_EMAIL}`}>Contact</a>}
          </div>
        </footer>
      </body>
    </html>
  );
}
