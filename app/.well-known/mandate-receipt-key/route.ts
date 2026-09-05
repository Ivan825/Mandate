import { NextResponse } from "next/server";
import { publicKeyPem, keyId } from "@/lib/receipts";
export async function GET() {
  return new NextResponse(publicKeyPem(), { headers: { "content-type": "application/x-pem-file", "x-key-id": keyId() } });
}
