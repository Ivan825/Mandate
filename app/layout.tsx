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

export const metadata: Metadata = {
  title: "Mandate",
  description: "Scoped, revocable spending authority for AI agents.",
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
  return (
    <html lang="en">
      <head>
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,600;8..60,700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" />
      </head>
      <body>
        <div className="topbar">
          <div className="topbar-in">
            <Link href="/" className="brand">Mandate</Link>
            {ctx && (
              <nav className="nav">
                <Link href="/">Exposure</Link>
                <Link href="/approvals">Approvals{pending > 0 && <span className="badge">{pending}</span>}</Link>
                <Link href="/ledger">Ledger</Link>
                <Link href="/proxy">API proxy</Link>
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
          </div>
        </div>
        <main className="main">
          {problems.length > 0 && <div className="notice bad" style={{ marginBottom: 20 }}><strong>Configuration problem.</strong> {problems.join(" ")}</div>}
          {children}
        </main>
      </body>
    </html>
  );
}
