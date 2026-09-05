"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { timingSafeEqual } from "node:crypto";
import { SESSION_COOKIE, sessionValue } from "@/lib/auth";

// Kept in its own module so the protected actions in app/actions.ts are
// never bundled into the public /login route.

export async function loginAction(form: FormData) {
  const pw = Buffer.from(String(form.get("password") ?? ""));
  const expected = Buffer.from(process.env.ADMIN_PASSWORD ?? "");
  const ok = expected.length > 0 && pw.length === expected.length && timingSafeEqual(pw, expected);
  if (!ok) redirect("/login?error=1");
  const jar = await cookies();
  jar.set(SESSION_COOKIE, sessionValue()!, { httpOnly: true, sameSite: "lax", secure: (process.env.NEXT_PUBLIC_BASE_URL ?? "").startsWith("https"), path: "/", maxAge: 60 * 60 * 24 * 30 });
  redirect("/");
}

export async function logoutAction() {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  redirect("/login");
}
