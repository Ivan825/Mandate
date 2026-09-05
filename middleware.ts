import { NextRequest, NextResponse } from "next/server";

// Single-owner protection. If ADMIN_PASSWORD is set, the dashboard needs a
// session cookie; agent endpoints and the Stripe webhook authenticate on
// their own (mandate token / signature) and are never behind the cookie.
// Server actions re-check the session themselves (lib/auth.ts).

async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function middleware(req: NextRequest) {
  const expected = process.env.ADMIN_PASSWORD;
  const { pathname } = req.nextUrl;
  if (pathname.startsWith("/api/agent") || pathname.startsWith("/api/webhooks") || pathname.startsWith("/a/")) return NextResponse.next();
  if (!expected) {
    // In production the dashboard never serves unprotected: it holds every agent's exposure and the approve buttons.
    if (process.env.NODE_ENV === "production") return new NextResponse("Mandate is not configured: set ADMIN_PASSWORD.", { status: 503 });
    return NextResponse.next();
  }
  if (pathname === "/login") return NextResponse.next();
  const cookie = req.cookies.get("mandate_session")?.value;
  if (cookie && cookie === (await hmacHex(expected, "mandate-owner-session-v1"))) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
