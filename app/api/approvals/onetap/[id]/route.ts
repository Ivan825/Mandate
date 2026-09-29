import { NextRequest, NextResponse } from "next/server";
import { parseLink, linkPrincipal } from "@/lib/notify";
import { decideApproval, getApproval } from "@/lib/service";
import { rateLimit, clientIp } from "@/lib/ratelimit";

// The one-tap decision as an API: POST /api/approvals/onetap/:id?d=approve&t=<signed>
// Same signed token as the /a/:id page, so the same authority — used by the
// service worker's notification buttons, which cannot submit a page form.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!(await rateLimit(`ip:${clientIp(req)}:onetap`, 30)).ok) return NextResponse.json({ error: "Too many attempts." }, { status: 429 });
  const { id } = await ctx.params;
  const d = req.nextUrl.searchParams.get("d");
  const t = req.nextUrl.searchParams.get("t") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id) || (d !== "approve" && d !== "deny")) return NextResponse.json({ error: "Bad request." }, { status: 400 });
  const link = parseLink(id, d, t);
  if (!link.ok) return NextResponse.json({ error: "This link is invalid or has expired." }, { status: 403 });
  const row = await getApproval(id);
  if (!row) return NextResponse.json({ error: "No such request." }, { status: 404 });
  // The link names its recipient; they must still be allowed to decide here.
  const who = await linkPrincipal(link.userId, row.a.workspaceId);
  if (who === "revoked") return NextResponse.json({ error: "You can no longer decide requests in this workspace." }, { status: 403 });
  const r = await decideApproval(null, id, d === "approve" ? "approved" : "denied", who ? who.email : "one-tap link", undefined, { userId: who?.userId ?? null });
  if (!r) return NextResponse.json({ error: "This request was already decided." }, { status: 409 });
  if ((r as { anonymous?: boolean }).anonymous) return NextResponse.json({ error: "This request needs several named approvers; sign in and co-sign it from the inbox." }, { status: 403 });
  return NextResponse.json({ ok: true, decision: r.status, cosigned: (r as { cosigned?: boolean }).cosigned ?? false });
}
