"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAgent, createMandate, getMandate, authorize, revokeMandate, decideApproval, attachCard, recordCardError } from "@/lib/service";
import { issueCardForMandate, deactivateCard, stripeEnabled, simulateStripeAuthorization } from "@/lib/stripe";
import { endOfLocalDay } from "@/lib/policy";
import { requireOwner } from "@/lib/auth";

// Every mutating action re-checks the owner session itself; the middleware
// is a convenience, not the boundary.

function num(v: FormDataEntryValue | null, fallback = 0): number {
  const n = parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : fallback;
}
function toMinor(major: number): number { return Math.round(major * 100); }
function lines(v: FormDataEntryValue | null): string[] {
  return String(v ?? "").split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}
function isUuid(s: string): boolean { return /^[0-9a-f-]{36}$/i.test(s); }

export async function createAgentAction(form: FormData) {
  await requireOwner();
  const name = String(form.get("name") ?? "").trim();
  if (!name) return;
  const a = await createAgent({ name, description: String(form.get("description") ?? "") });
  revalidatePath("/");
  redirect(`/mandates/new?agent=${a.id}`);
}

export type MandateFormState = { errors?: { field: string; message: string }[]; values?: Record<string, string> } | undefined;

export async function createMandateAction(_prev: MandateFormState, form: FormData): Promise<MandateFormState> {
  await requireOwner();
  // React resets the form after an action returns, so echo the entered values
  // back and let the form re-seed its defaults from them.
  const values: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string" && !k.startsWith("$")) values[k] = v;
  const agentId = String(form.get("agentId") ?? "");
  if (!isUuid(agentId)) return { errors: [{ field: "agentId", message: "Pick an agent." }], values };
  const timezone = String(form.get("timezone") ?? "Asia/Kolkata");
  const approvalRaw = String(form.get("approvalAbove") ?? "").trim();
  const expiresRaw = String(form.get("expiresAt") ?? "").trim();
  const res = await createMandate({
    agentId,
    name: String(form.get("name") ?? ""),
    currency: String(form.get("currency") ?? "USD"),
    perTxnLimit: toMinor(num(form.get("perTxnLimit"))),
    dailyLimit: toMinor(num(form.get("dailyLimit"))),
    totalLimit: toMinor(num(form.get("totalLimit"))),
    approvalAbove: approvalRaw === "" ? null : toMinor(num(approvalRaw)),
    allowedMerchants: lines(form.get("allowedMerchants")),
    blockedCategories: lines(form.get("blockedCategories")),
    activeHoursStart: Math.floor(num(form.get("activeHoursStart"), 0)),
    activeHoursEnd: Math.floor(num(form.get("activeHoursEnd"), 24)),
    timezone,
    expiresAt: /^\d{4}-\d{2}-\d{2}$/.test(expiresRaw) ? endOfLocalDay(expiresRaw, timezone) : null,
  });
  if (!res.ok) return { errors: res.errors, values };
  const m = res.mandate;
  if (form.get("issueCard") === "on" && stripeEnabled()) {
    try {
      const card = await issueCardForMandate(m, { name: m.name, email: process.env.CARDHOLDER_EMAIL ?? "agent@example.com" });
      await attachCard(m.id, card);
    } catch (e) {
      await recordCardError(m.id, (e as Error).message);
    }
  }
  revalidatePath("/");
  redirect(`/mandates/${m.id}?new=1`);
}

export async function simulatePurchaseAction(form: FormData) {
  await requireOwner();
  const id = String(form.get("mandateId") ?? "");
  if (!isUuid(id)) return;
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
  await requireOwner();
  const id = String(form.get("mandateId") ?? "");
  if (!isUuid(id)) return;
  const m = await getMandate(id);
  if (!m) return;
  if (m.stripeCardId && stripeEnabled()) { try { await deactivateCard(m.stripeCardId); } catch (e) { console.error((e as Error).message); } }
  await revokeMandate(id);
  revalidatePath("/");
  revalidatePath(`/mandates/${id}`);
  redirect(`/mandates/${id}`);
}

export async function decideApprovalAction(form: FormData) {
  await requireOwner();
  const id = String(form.get("approvalId") ?? "");
  if (!isUuid(id)) return;
  const decision = form.get("decision") === "approve" ? "approved" : "denied";
  await decideApproval(id, decision);
  revalidatePath("/approvals");
  revalidatePath("/");
  revalidatePath("/ledger");
  redirect("/approvals");
}

export async function sendTestNotificationAction() {
  await requireOwner();
  const { sendTest, configuredChannels } = await import("@/lib/notify");
  if (configuredChannels().length === 0) redirect("/settings?test=none");
  const outcomes = await sendTest();
  const failed = outcomes.filter((o) => !o.ok);
  redirect(failed.length ? `/settings?test=${encodeURIComponent(failed.map((f) => `${f.channel}: ${f.error}`).join("; "))}` : "/settings?test=ok");
}
