import { appUrl } from "./env";

// Same-origin paths only for post-sign-in and "back" redirects.
// "//evil.example", "/\\evil" and "/\t/evil.example" are all absolute URLs to
// a browser once control characters are stripped, so the candidate is
// resolved against our own origin and must stay there.
export function safeNext(raw: string | undefined | null, fallback = "/"): string {
  if (!raw || raw.length > 2000 || /[\x00-\x1f\x7f\\]/.test(raw) || !raw.startsWith("/") || raw.startsWith("//")) return fallback;
  try { const base = appUrl(); const u = new URL(raw, base); if (u.origin !== new URL(base).origin) return fallback; return u.pathname + u.search + u.hash; } catch { return fallback; }
}
