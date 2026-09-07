import { NextResponse } from "next/server";
import { getCtx } from "@/lib/session";
import { exportAccount } from "@/lib/service";

// Everything Mandate holds about you, as one JSON file.
export async function GET() {
  const ctx = await getCtx();
  if (!ctx) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const body = await exportAccount(ctx.userId);
  return new NextResponse(JSON.stringify(body, null, 2), { headers: { "content-type": "application/json", "content-disposition": `attachment; filename="mandate-account-export.json"` } });
}
