// Tools for the Vercel AI SDK: `tools: mandateTools(m)`. Peer deps: ai, zod.
import { z } from "zod";
import { tool } from "ai";
import type { Mandate } from "./index.js";

export function mandateTools(m: Mandate) {
  return {
    check_mandate: tool({
      description: "Read the spending mandate this agent holds: limits, what is left today and overall, allowed merchants, active hours, open holds. Call before planning a purchase.",
      inputSchema: z.object({}),
      execute: async () => m.mandate(),
    }),
    request_purchase: tool({
      description: "Ask for authorisation to spend BEFORE paying. amount is an integer in minor units (1299 = 12.99). Returns approved (a hold — capture after paying), declined (with a remedy), or pending (the owner must approve; tell the user, wait, retry with the same idempotencyKey).",
      inputSchema: z.object({ amount: z.number().int().positive(), merchant: z.string().min(1), purpose: z.string().optional(), category: z.string().optional(), idempotencyKey: z.string().optional() }),
      execute: async (input) => m.authorize(input),
    }),
    capture_purchase: tool({
      description: "After paying, record what was actually paid against an approved hold. amount defaults to the full authorised amount; less releases the difference.",
      inputSchema: z.object({ transactionId: z.string(), amount: z.number().int().positive().optional(), note: z.string().optional() }),
      execute: async ({ transactionId, ...rest }) => m.capture(transactionId, rest),
    }),
    propose_plan: tool({
      description: "Before a multi-step task, list what you intend to buy (merchant, maximum amount in minor units, purpose) as one plan. The owner approves the list once; each purchase inside it then passes request_purchase without asking. Poll get_plan until status is approved.",
      inputSchema: z.object({ title: z.string().min(1), items: z.array(z.object({ merchant: z.string(), amount: z.number().int().positive(), purpose: z.string().optional() })).min(1) }),
      execute: async (input) => m.proposePlan(input),
    }),
    get_plan: tool({ description: "Read a plan's status and which items are still available.", inputSchema: z.object({ planId: z.string() }), execute: async ({ planId }) => m.getPlan(planId) }),
    void_purchase: tool({
      description: "Nothing was paid: release the approved hold back to the limits.",
      inputSchema: z.object({ transactionId: z.string(), reason: z.string().optional() }),
      execute: async ({ transactionId, reason }) => m.void(transactionId, reason),
    }),
  };
}
