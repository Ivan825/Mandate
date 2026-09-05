import { cookies } from "next/headers";
import { createHmac, timingSafeEqual } from "node:crypto";

// Single-owner session for the MVP. The cookie is an HMAC of a fixed label
// under the admin password, so it never contains the password itself. Real
// multi-user auth replaces this module wholesale (see README roadmap).

export const SESSION_COOKIE = "mandate_session";

export function sessionValue(): string | null {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return null;
  return createHmac("sha256", pw).update("mandate-owner-session-v1").digest("hex");
}

export function protectedMode(): boolean {
  return Boolean(process.env.ADMIN_PASSWORD);
}

export async function isOwner(): Promise<boolean> {
  const expected = sessionValue();
  if (!expected) return true; // unprotected dev mode
  const got = (await cookies()).get(SESSION_COOKIE)?.value ?? "";
  if (got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

export async function requireOwner(): Promise<void> {
  if (!(await isOwner())) throw new Error("Not signed in.");
}
