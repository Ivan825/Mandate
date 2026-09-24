import { NextRequest, NextResponse } from "next/server";
import { factsFor, openHolds, settlementView } from "@/lib/service";
import { parseList } from "@/lib/policy";
import { authenticateMandate } from "@/lib/agent-auth";

// GET /api/agent/mandate — an agent reads its own limits, what is left and
// which of its holds are still open, so it can plan rather than discover
// limits by being declined.
export async function GET(req: NextRequest) {
  const a = await authenticateMandate(req);
  if (!a.ok) return a.response;
  const m = a.mandate;
  const [f, holds] = await Promise.all([factsFor(m), openHolds(m.workspaceId, m.id)]);
  return NextResponse.json({
    mandate: m.name, mandateId: m.id, status: m.status, currency: m.currency,
    limits: { perTransaction: m.perTxnLimit, daily: m.dailyLimit, total: m.totalLimit, approvalAbove: m.approvalAbove },
    remaining: { today: Math.max(0, m.dailyLimit - f.spentToday), total: Math.max(0, m.totalLimit - f.spentTotal) },
    scope: { allowedMerchants: parseList(m.allowedMerchants), blockedCategories: parseList(m.blockedCategories), activeHours: [m.activeHoursStart, m.activeHoursEnd], timezone: m.timezone },
    holds: { ttlHours: m.holdTtlHours, onExpiry: m.holdPolicy, open: holds.map(settlementView) },
    pendingApprovals: f.openPending,
    expiresAt: m.expiresAt, card: m.cardLast4 ? { last4: m.cardLast4 } : null,
  });
}
