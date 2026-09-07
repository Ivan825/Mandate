// The app's public URL, read at request time. NEXT_PUBLIC_* values are
// inlined at build time, which breaks a Docker image built once and run
// behind different hostnames; APP_URL (or BETTER_AUTH_URL) wins when set.
export function appUrl(): string {
  return (process.env.APP_URL ?? process.env.BETTER_AUTH_URL ?? process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

// "Production" is decided by NODE_ENV, not by which host we happen to be on:
// a Docker or bare-metal deployment must get the same guards as Vercel.
export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

// Everything a production deployment must have. Rendered in the topbar for
// signed-in users and logged at startup, so a missing secret is noticed on
// the first page load rather than on the first incident.
export function configProblems(): string[] {
  if (!isProduction()) return [];
  const out: string[] = [];
  const need = (name: string, why: string) => { if (!process.env[name]) out.push(`${name} is not set; ${why}`); };
  need("DATABASE_URL", "nothing can be stored.");
  need("BETTER_AUTH_SECRET", "sessions cannot be signed.");
  if (!process.env.APP_URL && !process.env.BETTER_AUTH_URL && !process.env.NEXT_PUBLIC_BASE_URL) out.push("APP_URL is not set; sign-in links, OAuth and MCP discovery need the public URL.");
  need("MANDATE_ENCRYPTION_KEY", "provider API keys cannot be encrypted (openssl rand -base64 32).");
  need("RECEIPT_SIGNING_KEY", "receipts cannot be signed (openssl rand -base64 32).");
  need("NOTIFY_SECRET", "one-tap approval links and show-once grants would be signed with the session secret.");
  const weak = (name: string) => { const v = process.env[name]; if (v && (v.length < 32 || /change-me|dev-only|ci-only|example/i.test(v))) out.push(`${name} looks like a placeholder; use at least 32 random characters.`); };
  weak("BETTER_AUTH_SECRET"); weak("NOTIFY_SECRET");
  if (appUrl().startsWith("http://") && !/localhost|127\.0\.0\.1/.test(appUrl())) out.push("APP_URL is http://; cookies and passkeys need https in production.");
  return out;
}
