#!/usr/bin/env node
// Minimal stdio MCP server (no dependencies) that gives any MCP client —
// Claude Code, Cursor, Codex — two tools backed by a Mandate token:
//   check_mandate    : what may I spend, and what is left?
//   request_purchase : ask to spend; returns approved / declined / pending.
//   capture_purchase : after paying, record what was actually paid
//   void_purchase    : nothing was paid; release the hold
//   get_purchase     : state of one authorisation
//
// Env: MANDATE_URL (e.g. http://localhost:3000), MANDATE_TOKEN (mnd_...)

import { createInterface } from "node:readline";

const URL_BASE = (process.env.MANDATE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const TOKEN = process.env.MANDATE_TOKEN ?? "";

const TOOLS = [
  {
    name: "check_mandate",
    description: "Read the spending mandate this agent holds: limits, remaining budget today and overall, allowed merchants, active hours. Call before planning any purchase.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "request_purchase",
    description: "Ask for authorisation to spend under the mandate BEFORE paying. amount is in minor units (cents/paise). Returns approved, declined (with reason) or pending (owner must approve in their inbox; tell the user and retry the identical request later).",
    inputSchema: {
      type: "object",
      properties: {
        amount: { type: "integer", description: "Amount in minor units, e.g. 1299 for $12.99" },
        merchant: { type: "string", description: "Merchant or service being paid" },
        purpose: { type: "string", description: "One line on why, shown to the owner" },
        category: { type: "string", description: "Optional merchant category slug" },
        idempotencyKey: { type: "string", description: "Reuse on retries of the same purchase so a network error never double-spends" },
      },
      required: ["amount", "merchant"],
      additionalProperties: false,
    },
  },
  {
    name: "capture_purchase",
    description: "After an approved purchase completes, record what was actually paid. amount defaults to the full authorised amount; less releases the difference; more is refused. One capture per hold.",
    inputSchema: {
      type: "object",
      properties: {
        transactionId: { type: "string", description: "From request_purchase" },
        amount: { type: "integer", description: "Minor units actually paid; omit for the full amount" },
        note: { type: "string", description: "Order or receipt reference" },
      },
      required: ["transactionId"],
      additionalProperties: false,
    },
  },
  {
    name: "void_purchase",
    description: "Nothing was paid: release the approved hold back to the mandate's limits.",
    inputSchema: {
      type: "object",
      properties: { transactionId: { type: "string" }, reason: { type: "string" } },
      required: ["transactionId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_purchase",
    description: "Current state of one purchase authorisation: held, captured, voided or released.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string" } }, required: ["transactionId"], additionalProperties: false },
  },
];

async function call(path, init) {
  const res = await fetch(URL_BASE + path, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: text };
}

async function handle(msg) {
  const { id, method, params } = msg;
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  switch (method) {
    case "initialize":
      return reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mandate", version: "0.4.0" } });
    case "notifications/initialized":
      return null;
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (!TOKEN) return reply({ content: [{ type: "text", text: "MANDATE_TOKEN is not set." }], isError: true });
      try {
        if (name === "check_mandate") {
          const r = await call("/api/agent/mandate", { method: "GET" });
          return reply({ content: [{ type: "text", text: r.body }], isError: r.status >= 400 });
        }
        if (name === "request_purchase") {
          const { idempotencyKey, ...body } = args ?? {};
          const r = await call("/api/agent/authorize", { method: "POST", body: JSON.stringify(body), headers: idempotencyKey ? { "idempotency-key": String(idempotencyKey).slice(0, 128) } : {} });
          return reply({ content: [{ type: "text", text: r.body }], isError: r.status >= 400 && r.status !== 403 });
        }
        if (name === "capture_purchase" || name === "void_purchase") {
          const r = await call(name === "capture_purchase" ? "/api/agent/capture" : "/api/agent/void", { method: "POST", body: JSON.stringify(args ?? {}) });
          return reply({ content: [{ type: "text", text: r.body }], isError: r.status >= 400 && r.status !== 409 });
        }
        if (name === "get_purchase") {
          const r = await call(`/api/agent/transactions/${encodeURIComponent(String(args?.transactionId ?? ""))}`, { method: "GET" });
          return reply({ content: [{ type: "text", text: r.body }], isError: r.status >= 400 });
        }
        return fail(-32601, `Unknown tool ${name}`);
      } catch (e) {
        return reply({ content: [{ type: "text", text: `Mandate server unreachable at ${URL_BASE}: ${e.message}` }], isError: true });
      }
    }
    default:
      return id === undefined ? null : fail(-32601, `Method not found: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const out = await handle(msg);
  if (out) process.stdout.write(JSON.stringify(out) + "\n");
});
