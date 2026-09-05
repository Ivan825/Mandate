import { randomUUID } from "node:crypto";

// Structured logs: one JSON line per event with a request id, so a decision
// can be traced from the agent's call through the policy engine to the
// ledger in whatever log system the deployment uses.

export type Log = { id: string; info: (event: string, data?: Record<string, unknown>) => void; warn: (event: string, data?: Record<string, unknown>) => void; error: (event: string, data?: Record<string, unknown>) => void };

export function logger(req?: Request, scope = "http"): Log {
  const id = req?.headers.get("x-request-id") ?? randomUUID();
  const base = { rid: id, scope, path: req ? new URL(req.url).pathname : undefined, method: req?.method };
  const emit = (level: string, event: string, data?: Record<string, unknown>) => {
    const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...base, ...(data ?? {}) });
    if (level === "error") console.error(line); else console.log(line);
  };
  return { id, info: (e, d) => emit("info", e, d), warn: (e, d) => emit("warn", e, d), error: (e, d) => emit("error", e, d) };
}
