import { NextRequest, NextResponse } from "next/server";
import { getMandateByToken, factsFor } from "@/lib/service";
import { parseList } from "@/lib/policy";

// GET /api/agent/mandate — lets an agent read its own limits and what is
// left, so it can plan rather than discover limits by being declined.
export async function GET(req: NextRequest) {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const m = token.startsWith("mnd_") ? await getMandateByToken(token) : null;
  if (!m) return NextResponse.json({ error: "Unknown mandate token." }, { status: 401 });
  const f = await factsFor(m);
  return NextResponse.json({
    mandate: m.name,
    status: m.status,
    currency: m.currency,
    limits: { perTransaction: m.perTxnLimit, daily: m.dailyLimit, total: m.totalLimit, approvalAbove: m.approvalAbove },
    remaining: { today: Math.max(0, m.dailyLimit - f.spentToday), total: Math.max(0, m.totalLimit - f.spentTotal) },
    scope: { allowedMerchants: parseList(m.allowedMerchants), blockedCategories: parseList(m.blockedCategories), activeHours: [m.activeHoursStart, m.activeHoursEnd], timezone: m.timezone },
    expiresAt: m.expiresAt,
    card: m.cardLast4 ? { last4: m.cardLast4 } : null,
  });
}
