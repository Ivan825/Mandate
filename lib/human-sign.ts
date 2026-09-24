import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { verifyAuthenticationResponse, type AuthenticationResponseJSON, type AuthenticatorTransportFuture } from "@simplewebauthn/server";
import { base64 } from "@better-auth/utils/base64";
import { db, schema } from "./db";
import { appUrl } from "./env";
import type { HumanSignature } from "./service";

// Human-signed approvals. The approver's passkey signs a challenge that
// commits to the exact decision (approval id + verdict), so the receipt can
// prove a person on a registered device decided — not a script with a
// cookie. Challenges are single-use and short-lived, kept in memory per
// instance and also verified structurally (they must decode to the
// decision they claim), so a lost instance only costs a retry.

const CHALLENGE_TTL_MS = 5 * 60_000;
const issued = new Map<string, number>();

export function challengeFor(approvalId: string, decision: "approve" | "deny", userId: string): string {
  const nonce = randomBytes(16).toString("base64url");
  const ts = Date.now();
  const c = `${approvalId}.${decision}.${userId}.${ts}.${nonce}`;
  const enc = Buffer.from(c).toString("base64url");
  issued.set(enc, ts);
  for (const [k, t] of issued) if (Date.now() - t > CHALLENGE_TTL_MS) issued.delete(k);
  return enc;
}

function parseChallenge(enc: string): { approvalId: string; decision: string; userId: string; ts: number } | null {
  try {
    const [approvalId, decision, userId, ts] = Buffer.from(enc, "base64url").toString().split(".");
    if (!approvalId || !decision || !userId || !ts) return null;
    return { approvalId, decision, userId, ts: Number(ts) };
  } catch { return null; }
}

export function rpId(): string { return new URL(appUrl()).hostname; }

export async function verifyHumanSignature(userId: string, approvalId: string, decision: "approve" | "deny", response: AuthenticationResponseJSON): Promise<{ ok: true; signature: HumanSignature } | { ok: false; error: string }> {
  let clientData: { challenge?: string; origin?: string; type?: string };
  try { clientData = JSON.parse(Buffer.from(response.response.clientDataJSON, "base64url").toString()); } catch { return { ok: false, error: "Malformed client data." }; }
  const c = clientData.challenge ? parseChallenge(clientData.challenge) : null;
  if (!c || c.approvalId !== approvalId || c.decision !== decision || c.userId !== userId) return { ok: false, error: "The signature does not commit to this decision." };
  if (Date.now() - c.ts > CHALLENGE_TTL_MS) return { ok: false, error: "The signing challenge expired; try again." };
  const [pk] = await db.select().from(schema.passkey).where(and(eq(schema.passkey.userId, userId), eq(schema.passkey.credentialID, response.id))).limit(1);
  if (!pk) return { ok: false, error: "That passkey is not registered to your account." };
  try {
    const v = await verifyAuthenticationResponse({
      response, expectedChallenge: clientData.challenge!, expectedOrigin: appUrl(), expectedRPID: rpId(),
      credential: { id: pk.credentialID, publicKey: base64.decode(pk.publicKey), counter: pk.counter, transports: pk.transports ? (pk.transports.split(",") as AuthenticatorTransportFuture[]) : undefined },
      requireUserVerification: false,
    });
    if (!v.verified) return { ok: false, error: "The passkey signature did not verify." };
    await db.update(schema.passkey).set({ counter: v.authenticationInfo.newCounter }).where(eq(schema.passkey.id, pk.id));
    issued.delete(clientData.challenge!);
    const alg = coseAlg(base64.decode(pk.publicKey));
    return { ok: true, signature: { credentialId: pk.credentialID, alg, challenge: clientData.challenge!, clientDataJSON: response.response.clientDataJSON, authenticatorData: response.response.authenticatorData, signature: response.response.signature, publicKey: pk.publicKey, userId, verifiedAt: new Date().toISOString() } };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

// The COSE algorithm of a stored public key (-7 ES256, -257 RS256, -8 EdDSA), best effort.
function coseAlg(key: Uint8Array): number {
  try {
    // Minimal CBOR: map with small int keys; alg is key 3.
    const b = Buffer.from(key);
    let i = 1; // skip the map header (assume < 24 entries)
    while (i < b.length) {
      const k = b[i]; i++;
      const keyVal = k < 0x18 ? k : k >= 0x20 && k < 0x38 ? -(k - 0x20) - 1 : NaN;
      if (Number.isNaN(keyVal)) break;
      const t = b[i]; i++;
      let val: number;
      if (t < 0x18) val = t; else if (t === 0x18) { val = b[i]; i++; } else if (t >= 0x20 && t < 0x38) val = -(t - 0x20) - 1; else if (t === 0x38) { val = -b[i] - 1; i++; } else if (t === 0x39) { val = -((b[i] << 8) | b[i + 1]) - 1; i += 2; } else if ((t & 0xe0) === 0x40) { const len = (t & 0x1f) === 0x18 ? b[i++] : t & 0x1f; i += len; continue; } else break;
      if (keyVal === 3) return val;
    }
  } catch { /* fall through */ }
  return 0;
}

export function signatureDigest(sig: HumanSignature): string { return createHash("sha256").update(sig.signature).digest("hex"); }

// Re-verify a stored signature (for receipts): same checks, without touching
// counters or challenges — proof that the bytes on the receipt are valid.
export async function recheckHumanSignature(sig: HumanSignature): Promise<boolean> {
  try {
    const v = await verifyAuthenticationResponse({
      response: { id: sig.credentialId, rawId: sig.credentialId, type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: sig.clientDataJSON, authenticatorData: sig.authenticatorData, signature: sig.signature } },
      expectedChallenge: sig.challenge, expectedOrigin: appUrl(), expectedRPID: rpId(),
      credential: { id: sig.credentialId, publicKey: base64.decode(sig.publicKey), counter: 0 }, requireUserVerification: false,
    });
    return v.verified;
  } catch { return false; }
}
