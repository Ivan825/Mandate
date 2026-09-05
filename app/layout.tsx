import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { countPending } from "@/lib/service";
import { configProblems } from "@/lib/db";
import { protectedMode, isOwner } from "@/lib/auth";
import { logoutAction } from "./auth-actions";

export const metadata: Metadata = {
  title: "Mandate",
  description: "Scoped, revocable spending authority for AI agents.",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  let pending = 0;
  try { pending = await countPending(); } catch { /* db not ready yet */ }
  const showSignOut = protectedMode() && (await isOwner());
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
            <nav className="nav">
              <Link href="/">Exposure</Link>
              <Link href="/approvals">Approvals{pending > 0 && <span className="badge">{pending}</span>}</Link>
              <Link href="/ledger">Ledger</Link>
              <Link href="/docs">Agent API</Link>
              <Link href="/settings">Settings</Link>
            </nav>
            <div className="spacer" />
            <Link href="/mandates/new" className="btn accent sm">Issue mandate</Link>
            {showSignOut && (
              <form action={logoutAction}><button className="btn secondary sm" type="submit">Sign out</button></form>
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
