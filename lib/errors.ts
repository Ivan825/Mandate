// Error reporting without a heavy SDK. With SENTRY_DSN set, unhandled server
// errors are sent as Sentry envelopes (works with Sentry, GlitchTip and any
// Sentry-compatible receiver). With ERROR_WEBHOOK_URL set, a JSON POST goes
// there instead or as well. Always logged as a structured line too.

type Ctx = { path?: string; method?: string; rid?: string; extra?: Record<string, unknown> };

export async function reportError(err: unknown, ctx: Ctx = {}) {
  const e = err instanceof Error ? err : new Error(String(err));
  const line = { t: new Date().toISOString(), level: "error", event: "unhandled", message: e.message, stack: e.stack?.split("\n").slice(0, 8).join("\n"), ...ctx };
  console.error(JSON.stringify(line));
  const tasks: Promise<unknown>[] = [];
  const dsn = process.env.SENTRY_DSN;
  if (dsn) tasks.push(sendSentry(dsn, e, ctx).catch(() => undefined));
  const hook = process.env.ERROR_WEBHOOK_URL;
  if (hook) tasks.push(fetch(hook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(line) }).catch(() => undefined));
  await Promise.race([Promise.all(tasks), new Promise((r) => setTimeout(r, 3000))]);
}

async function sendSentry(dsn: string, e: Error, ctx: Ctx) {
  const u = new URL(dsn);
  const projectId = u.pathname.replace(/^\//, "");
  const key = u.username;
  const endpoint = `${u.protocol}//${u.host}/api/${projectId}/envelope/`;
  const eventId = globalThis.crypto.randomUUID().replace(/-/g, "");
  const frames = (e.stack ?? "").split("\n").slice(1, 20).map((l) => l.trim()).reverse().map((l) => ({ function: l.replace(/^at\s+/, "").split(" (")[0], filename: (l.match(/\((.*?)\)/)?.[1] ?? "").split(":")[0] }));
  const event = {
    event_id: eventId, timestamp: Date.now() / 1000, platform: "node", level: "error", release: process.env.VERCEL_GIT_COMMIT_SHA ?? undefined,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development", server_name: "mandate",
    exception: { values: [{ type: e.name, value: e.message, stacktrace: { frames } }] },
    tags: { path: ctx.path ?? "", method: ctx.method ?? "" }, extra: { rid: ctx.rid, ...(ctx.extra ?? {}) },
  };
  const envelope = JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString(), dsn }) + "\n" + JSON.stringify({ type: "event" }) + "\n" + JSON.stringify(event) + "\n";
  await fetch(endpoint, { method: "POST", headers: { "content-type": "application/x-sentry-envelope", "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${key}, sentry_client=mandate/1.0` }, body: envelope });
}
