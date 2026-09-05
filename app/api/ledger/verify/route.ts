import { NextResponse } from "next/server";
import { verifyChain } from "@/lib/ledger";
export async function GET() {
  return NextResponse.json(await verifyChain());
}
