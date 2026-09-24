import { NextRequest, NextResponse } from "next/server";
import { verifyLink } from "@/lib/notify";
import { decideApproval } from "@/lib/service";
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
  if (!verifyLink(id, d, t)) return NextResponse.json({ error: "This link is invalid or has expired." }, { status: 403 });
  const r = await decideApproval(null, id, d === "approve" ? "approved" : "denied", "one-tap (push)");
  if (!r) return NextResponse.json({ error: "This request was already decided." }, { status: 409 });
  return NextResponse.json({ ok: true, decision: r.status });
}
