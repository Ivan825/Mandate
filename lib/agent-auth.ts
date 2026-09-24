import { NextRequest, NextResponse } from "next/server";
import { getMandateByToken } from "./service";
import { rateLimit, clientIp } from "./ratelimit";
import type { Mandate } from "./schema";

// The one way an agent that holds a mandate token identifies itself to the
// REST API. Rate-limited per address and per mandate before the database is
// asked anything expensive.
export async function authenticateMandate(req: NextRequest): Promise<{ ok: true; mandate: Mandate } | { ok: false; response: NextResponse }> {
  const ip = await rateLimit(`ip:${clientIp(req)}:agent`, 600);
  if (!ip.ok) return { ok: false, response: NextResponse.json({ error: "Too many requests from this address." }, { status: 429, headers: { "retry-after": String(ip.resetSec) } }) };
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token.startsWith("mnd_")) return { ok: false, response: NextResponse.json({ error: "Missing mandate token. Send it as Authorization: Bearer mnd_..." }, { status: 401 }) };
  const m = await getMandateByToken(token);
  if (!m) return { ok: false, response: NextResponse.json({ error: "Unknown mandate token." }, { status: 401 }) };
  const rl = await rateLimit(`mandate:${m.id}:agent`, 120);
  if (!rl.ok) return { ok: false, response: NextResponse.json({ error: "This mandate is being called too fast; slow down." }, { status: 429, headers: { "retry-after": String(rl.resetSec) } }) };
  return { ok: true, mandate: m };
}

export async function readJson<T>(req: NextRequest): Promise<T | null> {
  try { const v = await req.json(); return v && typeof v === "object" ? (v as T) : null; } catch { return null; }
}
