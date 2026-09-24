// Function-calling definitions for the OpenAI SDK (chat completions or
// Responses), plus a dispatcher that runs what the model asked for.
import type { Mandate } from "./index.js";

export const TOOL_SCHEMAS = [
  { name: "check_mandate", description: "Read the spending mandate this agent holds: limits, what is left today and overall, allowed merchants, active hours, open holds. Call before planning a purchase.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "request_purchase", description: "Ask for authorisation to spend BEFORE paying. amount is an integer in minor units (1299 = 12.99). Returns approved (a hold — capture after paying), declined (with a remedy: when to retry, the most that would pass now), or pending (the owner must approve; tell the user, wait, retry with the same idempotency_key).", parameters: { type: "object", properties: { amount: { type: "integer" }, merchant: { type: "string" }, purpose: { type: "string" }, category: { type: "string" }, idempotency_key: { type: "string" } }, required: ["amount", "merchant"], additionalProperties: false } },
  { name: "capture_purchase", description: "After paying, record what was actually paid against an approved hold. amount defaults to the full authorised amount; less releases the difference.", parameters: { type: "object", properties: { transaction_id: { type: "string" }, amount: { type: "integer" }, note: { type: "string" } }, required: ["transaction_id"], additionalProperties: false } },
  { name: "void_purchase", description: "Nothing was paid: release the approved hold back to the limits.", parameters: { type: "object", properties: { transaction_id: { type: "string" }, reason: { type: "string" } }, required: ["transaction_id"], additionalProperties: false } },
] as const;

export function openaiTools() { return TOOL_SCHEMAS.map((s) => ({ type: "function" as const, function: s })); }

export async function dispatch(m: Mandate, name: string, args: unknown): Promise<unknown> {
  const a = (typeof args === "string" ? JSON.parse(args) : args ?? {}) as Record<string, unknown>;
  switch (name) {
    case "check_mandate": return m.mandate();
    case "request_purchase": return m.authorize({ amount: Number(a.amount), merchant: String(a.merchant), purpose: a.purpose ? String(a.purpose) : undefined, category: a.category ? String(a.category) : undefined, idempotencyKey: a.idempotency_key ? String(a.idempotency_key) : undefined });
    case "capture_purchase": return m.capture(String(a.transaction_id), { amount: a.amount != null ? Number(a.amount) : undefined, note: a.note ? String(a.note) : undefined });
    case "void_purchase": return m.void(String(a.transaction_id), a.reason ? String(a.reason) : undefined);
    default: throw new Error(`Unknown tool ${name}`);
  }
}
