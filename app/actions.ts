"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { createHash } from "node:crypto";
import { createAgent, createMandate, getMandate, authorize, revokeMandate, decideApproval, attachCard } from "@/lib/service";
import { issueCardForMandate, deactivateCard, stripeEnabled, simulateStripeAuthorization } from "@/lib/stripe";

function num(v: FormDataEntryValue | null, fallback = 0): number {
  const n = parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : fallback;
}
function toMinor(major: number): number { return Math.round(major * 100); }
function lines(v: FormDataEntryValue | null): string[] {
  return String(v ?? "").split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

export async function createAgentAction(form: FormData) {
  const name = String(form.get("name") ?? "").trim();
  if (!name) return;
  const a = await createAgent({ name, description: String(form.get("description") ?? "") });
  revalidatePath("/");
  redirect(`/mandates/new?agent=${a.id}`);
}

export async function createMandateAction(form: FormData) {
  const agentId = String(form.get("agentId") ?? "");
  const name = String(form.get("name") ?? "").trim();
  if (!agentId || !name) return;
  const approvalRaw = String(form.get("approvalAbove") ?? "").trim();
  const expiresRaw = String(form.get("expiresAt") ?? "").trim();
  const m = await createMandate({
    agentId,
    name,
    currency: String(form.get("currency") ?? "USD"),
    perTxnLimit: toMinor(num(form.get("perTxnLimit"))),
    dailyLimit: toMinor(num(form.get("dailyLimit"))),
    totalLimit: toMinor(num(form.get("totalLimit"))),
    approvalAbove: approvalRaw === "" ? null : toMinor(num(approvalRaw)),
    allowedMerchants: lines(form.get("allowedMerchants")),
    blockedCategories: lines(form.get("blockedCategories")),
    activeHoursStart: Math.max(0, Math.min(23, Math.floor(num(form.get("activeHoursStart"), 0)))),
    activeHoursEnd: Math.max(1, Math.min(24, Math.floor(num(form.get("activeHoursEnd"), 24)))),
    timezone: String(form.get("timezone") ?? "Asia/Kolkata"),
    expiresAt: expiresRaw ? new Date(expiresRaw) : null,
  });
  if (form.get("issueCard") === "on" && stripeEnabled()) {
    try {
      const card = await issueCardForMandate(m, { name: `Agent ${name}`.slice(0, 24), email: "agent@example.com" });
      await attachCard(m.id, card);
    } catch (e) {
      console.error("Card issuance failed:", (e as Error).message);
    }
  }
  revalidatePath("/");
  redirect(`/mandates/${m.id}?new=1`);
}

export async function simulatePurchaseAction(form: FormData) {
  const id = String(form.get("mandateId") ?? "");
  const m = await getMandate(id);
  if (!m) return;
  const amount = toMinor(num(form.get("amount")));
  const merchant = String(form.get("merchant") ?? "").trim() || "unknown merchant";
  const purpose = String(form.get("purpose") ?? "").trim();
  const category = String(form.get("category") ?? "").trim();
  const viaStripe = form.get("viaStripe") === "on" && stripeEnabled() && m.stripeCardId;
  if (viaStripe) {
    // Stripe fires issuing_authorization.request at our webhook; the decision is recorded there.
    try { await simulateStripeAuthorization(m.stripeCardId!, amount, merchant); } catch (e) { console.error((e as Error).message); }
  } else {
    await authorize(m, { amount, merchant, purpose, category }, "simulation");
  }
  revalidatePath(`/mandates/${id}`);
  revalidatePath("/");
  revalidatePath("/approvals");
  revalidatePath("/ledger");
  redirect(`/mandates/${id}`);
}

export async function revokeMandateAction(form: FormData) {
  const id = String(form.get("mandateId") ?? "");
  const m = await getMandate(id);
  if (!m) return;
  if (m.stripeCardId && stripeEnabled()) { try { await deactivateCard(m.stripeCardId); } catch (e) { console.error((e as Error).message); } }
  await revokeMandate(id);
  revalidatePath("/");
  revalidatePath(`/mandates/${id}`);
  redirect(`/mandates/${id}`);
}

export async function decideApprovalAction(form: FormData) {
  const id = String(form.get("approvalId") ?? "");
  const decision = form.get("decision") === "approve" ? "approved" : "denied";
  await decideApproval(id, decision);
  revalidatePath("/approvals");
  revalidatePath("/");
  revalidatePath("/ledger");
  redirect("/approvals");
}

export async function loginAction(form: FormData) {
  const pw = String(form.get("password") ?? "");
  const expected = process.env.ADMIN_PASSWORD ?? "";
  if (!expected || pw !== expected) redirect("/login?error=1");
  const jar = await cookies();
  jar.set("mandate_session", createHash("sha256").update(expected).digest("hex"), { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30 });
  redirect("/");
}

export async function logoutAction() {
  const jar = await cookies();
  jar.delete("mandate_session");
  redirect("/login");
}
