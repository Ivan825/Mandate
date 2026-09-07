import { NextRequest, NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

// Optimistic gate: pages need a session cookie, otherwise go to sign-in.
// Real authorisation happens in each page and action via lib/session.ts.
// Agent-facing routes authenticate themselves (mandate token, OAuth bearer,
// Stripe signature, signed one-tap link) and are never behind the cookie.

const OPEN = ["/sign-in", "/consent", "/a/", "/api/auth", "/api/agent", "/api/mcp", "/api/proxy", "/api/receipts", "/api/webhooks", "/api/cron", "/oauth2", "/.well-known", "/terms", "/privacy", "/invite/"];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (OPEN.some((p) => pathname === p || pathname.startsWith(p))) return NextResponse.next();
  const cookie = getSessionCookie(req);
  if (cookie) return NextResponse.next();
  if (pathname === "/") return NextResponse.next(); // public landing page
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/sign-in";
  url.search = pathname !== "/" ? `?next=${encodeURIComponent(pathname)}` : "";
  return NextResponse.redirect(url);
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
