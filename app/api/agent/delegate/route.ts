import { NextRequest, NextResponse } from "next/server";
import { delegateMandate, MAX_AMOUNT } from "@/lib/service";
import { authenticateMandate, readJson } from "@/lib/agent-auth";
import { appUrl } from "@/lib/env";

// POST /api/agent/delegate — an agent carves a narrower sub-mandate out of
// its own for a helper it runs (a sub-agent, a tool, a one-off job). Every
// term must fit inside the parent's; the child's spend counts against the
// parent's limits; revoking the parent revokes the child. The child's token
// is returned once, here, for the agent to hand on.
//
//   { "name": "Price checker", "perTxnLimit": 500, "dailyLimit": 2000, "totalLimit": 5000,
//     "approvalAbove": 300, "allowedMerchants": ["OpenAI"], "expiresAt": "2026-10-01", "agentName": "helper-1" }
type Body = { name?: unknown; perTxnLimit?: unknown; dailyLimit?: unknown; totalLimit?: unknown; approvalAbove?: unknown; allowedMerchants?: unknown; blockedCategories?: unknown; expiresAt?: unknown; agentName?: unknown };

const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 && v <= MAX_AMOUNT ? v : null);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean).slice(0, 50) : undefined);

export async function POST(req: NextRequest) {
  const a = await authenticateMandate(req);
  if (!a.ok) return a.response;
  const parent = a.mandate;
  const b = await readJson<Body>(req);
  if (!b) return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  const name = typeof b.name === "string" ? b.name.trim().slice(0, 80) : "";
  const perTxnLimit = int(b.perTxnLimit), dailyLimit = int(b.dailyLimit), totalLimit = int(b.totalLimit);
  if (!name || perTxnLimit == null || dailyLimit == null || totalLimit == null) return NextResponse.json({ error: "name, perTxnLimit, dailyLimit and totalLimit (positive integers, minor units) are required." }, { status: 400 });
  let approvalAbove: number | null | undefined = undefined;
  if (b.approvalAbove === null) approvalAbove = null;
  else if (b.approvalAbove !== undefined) { if (typeof b.approvalAbove !== "number" || !Number.isInteger(b.approvalAbove) || b.approvalAbove < 0) return NextResponse.json({ error: "approvalAbove must be a non-negative integer or null." }, { status: 400 }); approvalAbove = b.approvalAbove; }
  let expiresAt: Date | null | undefined = undefined;
  if (b.expiresAt === null) expiresAt = null;
  else if (typeof b.expiresAt === "string") { const d = new Date(b.expiresAt); if (Number.isNaN(d.getTime())) return NextResponse.json({ error: "expiresAt must be an ISO date." }, { status: 400 }); expiresAt = d; }
  const r = await delegateMandate(parent, { name, perTxnLimit, dailyLimit, totalLimit, approvalAbove, allowedMerchants: strs(b.allowedMerchants), blockedCategories: strs(b.blockedCategories), expiresAt, agentName: typeof b.agentName === "string" ? b.agentName : undefined, by: `token ${parent.tokenPrefix}…` });
  if (!r.ok) return NextResponse.json({ error: "The sub-mandate does not fit inside this mandate.", errors: r.errors }, { status: 400 });
  const m = r.mandate;
  return NextResponse.json({
    mandateId: m.id, parentId: parent.id, name: m.name, token: r.token, currency: m.currency, depth: m.depth,
    limits: { perTransaction: m.perTxnLimit, daily: m.dailyLimit, total: m.totalLimit, approvalAbove: m.approvalAbove },
    scope: { allowedMerchants: JSON.parse(m.allowedMerchants), blockedCategories: JSON.parse(m.blockedCategories), activeHours: [m.activeHoursStart, m.activeHoursEnd], timezone: m.timezone },
    expiresAt: m.expiresAt, sandbox: m.sandbox === 1,
    next: `Give the token to the helper. It calls POST ${appUrl()}/api/agent/authorize exactly as you do; its spend counts against your limits; revoking your mandate revokes it.`,
  }, { status: 201 });
}
