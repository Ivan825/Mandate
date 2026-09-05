import { NextRequest, NextResponse } from "next/server";

// Single-owner protection. If ADMIN_PASSWORD is set, the dashboard needs a
// session cookie; agent endpoints and the Stripe webhook authenticate on
// their own (mandate token / signature) and are never behind the cookie.

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function middleware(req: NextRequest) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return NextResponse.next();
  const { pathname } = req.nextUrl;
  if (pathname.startsWith("/api/agent") || pathname.startsWith("/api/webhooks") || pathname === "/login" || pathname.startsWith("/_next")) return NextResponse.next();
  const cookie = req.cookies.get("mandate_session")?.value;
  if (cookie && cookie === (await sha256Hex(expected))) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  return NextResponse.redirect(url);
}

export const config = { matcher: ["/((?!favicon.ico).*)"] };
