import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { countPending, getWorkspaceSettings } from "@/lib/service";
import { PanicButton } from "./panic";
import { configProblems } from "@/lib/db";
import { getCtx } from "@/lib/session";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { signOutAction, switchWorkspaceAction, freezeWorkspaceAction, unfreezeWorkspaceAction } from "./actions";
import { WorkspaceSwitcher } from "./switcher";
import { ThemeToggle, type Theme } from "./theme";
import { LiveRefresh } from "./live";
import { PwaRegister } from "./pwa";
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
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Mandate", statusBarStyle: "black-translucent" },
  icons: { apple: "/icons/apple-touch-icon.png" },
};

export const viewport = { themeColor: "#B8631B" };

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getCtx();
  let pending = 0;
  let orgs: { id: string; name: string }[] = [];
  let frozen: { at: Date; by: string; reason: string } | null = null;
  if (ctx) {
    try { pending = await countPending(ctx.workspaceId); } catch { /* db not ready yet */ }
    try { frozen = (await getWorkspaceSettings(ctx.workspaceId)).frozen; } catch { /* ignore */ }
    try { orgs = (await auth.api.listOrganizations({ headers: await headers() })).map((o) => ({ id: o.id, name: o.name })); } catch { /* ignore */ }
  }
  const problems = configProblems();
  const source = process.env.SOURCE_URL ?? "https://github.com/Ivan825/Mandate";
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
                <Link href="/activity">Activity</Link>
                <Link href="/ledger">Ledger</Link>
                <Link href="/stats">Stats</Link>
                <Link href="/proxy">Proxy</Link>
                {stripeEnabled() && <Link href="/balance">Balance</Link>}
                <Link href="/members">Members</Link>
                <Link href="/connect">Connect</Link>
                <Link href="/settings">Settings</Link>
              </nav>
            )}
            <div className="spacer" />
            {ctx ? (
              <>
                <WorkspaceSwitcher current={ctx.workspaceId} orgs={orgs} action={switchWorkspaceAction} />
                {(ctx.role === "owner" || ctx.role === "admin") && !frozen && <PanicButton action={freezeWorkspaceAction} />}
                {(ctx.role === "owner" || ctx.role === "admin") && <Link href="/mandates/new" className="btn accent sm">Issue mandate</Link>}
                <form action={signOutAction}><button className="btn secondary sm" type="submit" title={ctx.email}>Sign out</button></form>
              </>
            ) : (
              <>
                <nav className="nav pubnav" aria-label="Site">
                  <a href="/#demo">Demo</a>
                  <a href="/#how">How it works</a>
                  <a href="/#rails">Rails</a>
                  <a href="/#proof">Proof</a>
                  <Link href="/docs">Docs</Link>
                  <a href={source} rel="noopener">GitHub</a>
                </nav>
                <Link href="/sign-in" className="btn secondary sm pub-signin">Sign in</Link>
                <Link href="/sign-in" className="btn accent sm">Start free</Link>
              </>
            )}
            <ThemeToggle initial={theme} />
            {ctx && <LiveRefresh />}
            {ctx && <PwaRegister />}
          </div>
        </div>
        <main className={ctx ? "main" : "main public"}>
          {problems.length > 0 && isOperator(ctx?.email) && <div className="notice bad" style={{ marginBottom: 20 }}><strong>Configuration problem (shown to operators only).</strong> {problems.join(" ")}</div>}
          {ctx && frozen && (
            <div className="notice bad frozen" style={{ marginBottom: 20 }}>
              <div className="page-head" style={{ marginBottom: 0 }}>
                <div><strong>Everything is frozen.</strong> {frozen.by} pressed the panic button {new Date(frozen.at).toUTCString().replace(" GMT", " UTC")}{frozen.reason ? <> — “{frozen.reason}”</> : null}. Every agent in this workspace is declined on every rail — cards, API, MCP, proxy — until someone unfreezes. Nothing was revoked; lifting the freeze puts everything back as it was.</div>
                {(ctx.role === "owner" || ctx.role === "admin") && <form action={unfreezeWorkspaceAction}><button className="btn ok" type="submit">Unfreeze</button></form>}
              </div>
            </div>
          )}
          {children}
        </main>
        {ctx ? (
          <footer className="sitefoot">
            <div className="sitefoot-in">
              <span>Mandate</span>
              <Link href="/terms">Terms</Link>
              <Link href="/privacy">Privacy</Link>
              <Link href="/docs">Connect agents</Link>
              {process.env.LEGAL_CONTACT_EMAIL && <a href={`mailto:${process.env.LEGAL_CONTACT_EMAIL}`}>Contact</a>}
              <a href={source} rel="noopener">Source</a>
            </div>
          </footer>
        ) : (
          <footer className="pubfoot">
            <div className="pubfoot-in">
              <div className="pubfoot-brand">
                <span className="brand"><span className="mark" aria-hidden /> Mandate</span>
                <p>Scoped, revocable spending authority for AI agents. Open source under AGPL-3.0; run the hosted beta or your own.</p>
              </div>
              <div><div className="eyebrow">Product</div><a href="/#demo">Demo</a><a href="/#how">How it works</a><a href="/#rails">Rails</a><a href="/#controls">Controls</a><Link href="/docs">Docs</Link><Link href="/anchors">Public anchors</Link></div>
              <div><div className="eyebrow">Trust</div><a href={`${source}/blob/main/docs/SAFETY-CASE.md`} rel="noopener">Safety case</a><a href={`${source}/blob/main/docs/RED-TEAM.md`} rel="noopener">Red-team results</a><a href={`${source}/blob/main/docs/SECURITY-AUDIT.md`} rel="noopener">Security audit</a><a href={`${source}/blob/main/SECURITY.md`} rel="noopener">Report a vulnerability</a></div>
              <div><div className="eyebrow">Project</div><a href={source} rel="noopener">GitHub</a><a href={`${source}/blob/main/CHANGELOG.md`} rel="noopener">Changelog</a><a href={`${source}/blob/main/DEPLOY.md`} rel="noopener">Deploy your own</a><Link href="/terms">Terms</Link><Link href="/privacy">Privacy</Link>{process.env.LEGAL_CONTACT_EMAIL && <a href={`mailto:${process.env.LEGAL_CONTACT_EMAIL}`}>Contact</a>}</div>
            </div>
            <div className="pubfoot-end">© {new Date().getFullYear()} Mandate · AGPL-3.0 · Not a bank, not a card issuer: a control and record-keeping layer in front of the ones you already use.</div>
          </footer>
        )}
      </body>
    </html>
  );
}
