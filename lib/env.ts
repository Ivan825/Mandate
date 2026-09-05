// The app's public URL, read at request time. NEXT_PUBLIC_* values are
// inlined at build time, which breaks a Docker image built once and run
// behind different hostnames; APP_URL (or BETTER_AUTH_URL) wins when set.
export function appUrl(): string {
  return (process.env.APP_URL ?? process.env.BETTER_AUTH_URL ?? process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
}
