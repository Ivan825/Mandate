import { createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, schema } from "./db";
import { canonical } from "./ledger";
import { publicKeyPem, keyId, signingKey } from "./receipts";
import { captureTransaction, type SettleResult } from "./service";
import type { Mandate, Transaction } from "./schema";

// Authorisation vouchers. When Mandate approves a purchase it can hand the
// agent a compact, signed token — the voucher — that says "this agent may
// spend up to X at Y until T under mandate M, decision D". The agent
// presents it to the merchant; the merchant verifies the signature offline
// with Mandate's public key (no account, no API call), then redeems it here
// to capture what was actually bought. It is a payment authorisation that
// needs no card network: the agent's authority travels with the request.
//
//   mv1.<base64url payload JSON>.<base64url Ed25519 signature>
//   signature is over the bytes  "mandate-voucher|" + payload JSON
//
// Vouchers are bearer tokens with a short life (the hold's TTL). Single-use
// is enforced by the transaction: a hold captures once.

export type VoucherPayload = { v: 1; tx: string; mandate: string; agent: string; amount: number; currency: string; merchant: string; purpose: string; issuedAt: string; expiresAt: string; issuer: string; keyId: string };

const PREFIX = "mandate-voucher|";
const b64 = (b: Buffer) => b.toString("base64url");

export function issueVoucher(t: Transaction, m: Mandate, agentName: string, issuer: string): string | null {
  if (t.decision !== "approved" || t.amount <= 0) return null;
  const issuedAt = new Date().toISOString();
  const expiresAt = (t.holdExpiresAt ? new Date(t.holdExpiresAt) : new Date(new Date(t.createdAt).getTime() + 24 * 3600_000)).toISOString();
  const payload: VoucherPayload = { v: 1, tx: t.id, mandate: m.id, agent: agentName, amount: t.authorizedAmount ?? t.amount, currency: t.currency, merchant: t.merchant, purpose: t.purpose, issuedAt, expiresAt, issuer, keyId: keyId() };
  const body = canonical(payload);
  const sig = edSign(null, Buffer.from(PREFIX + body), signingKey());
  return `mv1.${b64(Buffer.from(body))}.${b64(sig)}`;
}

export type VoucherCheck = { valid: boolean; payload: VoucherPayload | null; error?: string; expired?: boolean };

// Offline part: structure, signature against THIS server's key, expiry.
export function verifyVoucher(voucher: string, now = new Date()): VoucherCheck {
  try {
    const [tag, p, s] = voucher.trim().split(".");
    if (tag !== "mv1" || !p || !s) return { valid: false, payload: null, error: "Not a Mandate voucher (expected mv1.<payload>.<signature>)." };
    const body = Buffer.from(p, "base64url").toString("utf8");
    const payload = JSON.parse(body) as VoucherPayload;
    if (payload.v !== 1 || typeof payload.tx !== "string" || typeof payload.amount !== "number") return { valid: false, payload: null, error: "Malformed voucher payload." };
    const ok = edVerify(null, Buffer.from(PREFIX + body), createPublicKey(publicKeyPem()), Buffer.from(s, "base64url"));
    if (!ok) return { valid: false, payload, error: "Signature does not verify against this server's key." };
    const expired = now > new Date(payload.expiresAt);
    return { valid: !expired, payload, expired, error: expired ? "Voucher expired." : undefined };
  } catch { return { valid: false, payload: null, error: "Unreadable voucher." }; }
}

export type VoucherStatus = VoucherCheck & { redeemable: boolean; settlement: string | null; capturedAmount: number | null; mandateStatus: string | null; workspaceFrozen: boolean };

// Online part: what has happened to the decision since.
export async function voucherStatus(voucher: string): Promise<VoucherStatus> {
  const c = verifyVoucher(voucher);
  const base: VoucherStatus = { ...c, redeemable: false, settlement: null, capturedAmount: null, mandateStatus: null, workspaceFrozen: false };
  if (!c.payload) return base;
  const [t] = await db.select().from(schema.transactions).where(and(eq(schema.transactions.id, c.payload.tx), eq(schema.transactions.mandateId, c.payload.mandate))).limit(1);
  if (!t) return { ...base, error: c.error ?? "The decision this voucher refers to does not exist." };
  const [m] = await db.select({ status: schema.mandates.status, workspaceId: schema.mandates.workspaceId }).from(schema.mandates).where(eq(schema.mandates.id, t.mandateId)).limit(1);
  const [ws] = m ? await db.select({ frozenAt: schema.workspaceSettings.frozenAt }).from(schema.workspaceSettings).where(eq(schema.workspaceSettings.workspaceId, m.workspaceId)).limit(1) : [];
  const frozen = Boolean(ws?.frozenAt);
  const redeemable = c.valid && t.settlement === "held" && m?.status === "active" && !frozen;
  return { ...base, redeemable, settlement: t.settlement, capturedAmount: t.settlement === "captured" ? t.amount : null, mandateStatus: m?.status ?? null, workspaceFrozen: frozen, error: c.error ?? (t.settlement !== "held" ? `Already ${t.settlement}.` : frozen ? "The workspace is frozen." : m?.status !== "active" ? `The mandate is ${m?.status}.` : undefined) };
}

// The merchant captures what it sold against the voucher; less than the
// authorised amount gives the difference back to the agent's limits.
export async function redeemVoucher(voucher: string, opts: { amount?: number; merchant: string; reference?: string }): Promise<{ ok: true; result: Extract<SettleResult, { ok: true }>; payload: VoucherPayload } | { ok: false; status: number; error: string }> {
  const st = await voucherStatus(voucher);
  if (!st.payload) return { ok: false, status: 400, error: st.error ?? "Invalid voucher." };
  if (!st.redeemable) return { ok: false, status: 409, error: st.error ?? "This voucher cannot be redeemed." };
  const by = `merchant:${opts.merchant.trim().slice(0, 60) || st.payload.merchant}`;
  const r = await captureTransaction({ mandateId: st.payload.mandate }, st.payload.tx, { amount: opts.amount, by, note: `Voucher redeemed${opts.reference ? ` · ref ${opts.reference.trim().slice(0, 80)}` : ""}` });
  if (!r.ok) return { ok: false, status: r.code === "bad_amount" ? 400 : 409, error: r.message };
  return { ok: true, result: r, payload: st.payload };
}
