import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { listApprovals } from "@/lib/service";
import { logoutAction } from "./actions";

export const metadata: Metadata = {
  title: "Mandate",
  description: "Scoped, revocable spending authority for AI agents.",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  let pending = 0;
  try { pending = (await listApprovals("pending")).length; } catch { /* db not ready yet */ }
  const protectedMode = Boolean(process.env.ADMIN_PASSWORD);
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
            </nav>
            <div className="spacer" />
            <Link href="/mandates/new" className="btn accent sm">Issue mandate</Link>
            {protectedMode && (
              <form action={logoutAction}><button className="btn secondary sm" type="submit">Sign out</button></form>
            )}
          </div>
        </div>
        <main className="main">{children}</main>
      </body>
    </html>
  );
}
