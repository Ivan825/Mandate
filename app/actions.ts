"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { createAgent, createMandate, getMandate, authorize, revokeMandate, decideApproval, attachCard, recordCardError } from "@/lib/service";
import { issueCardForMandate, deactivateCard, stripeEnabled, simulateStripeAuthorization } from "@/lib/stripe";
import { endOfLocalDay } from "@/lib/policy";
import { requireCtx } from "@/lib/session";
import { auth } from "@/lib/auth";
import { revokeConnectedAgent } from "@/lib/connections";

// Every mutating action resolves the caller's workspace from the session
// first; ids from forms are only ever used inside that workspace.

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
  const ctx = await requireCtx();
  const name = String(form.get("name") ?? "").trim();
  if (!name) return;
  const a = await createAgent(ctx.workspaceId, { name, description: String(form.get("description") ?? "") });
  revalidatePath("/");
  redirect(`/mandates/new?agent=${a.id}`);
}

export type MandateFormState = { errors?: { field: string; message: string }[]; values?: Record<string, string> } | undefined;

export async function createMandateAction(_prev: MandateFormState, form: FormData): Promise<MandateFormState> {
  const ctx = await requireCtx();
  // React resets the form after an action returns, so echo the entered values
  // back and let the form re-seed its defaults from them.
  const values: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string" && !k.startsWith("$")) values[k] = v;
  const agentId = String(form.get("agentId") ?? "");
  if (!isUuid(agentId)) return { errors: [{ field: "agentId", message: "Pick an agent." }], values };
  const timezone = String(form.get("timezone") ?? "Asia/Kolkata");
  const approvalRaw = String(form.get("approvalAbove") ?? "").trim();
  const expiresRaw = String(form.get("expiresAt") ?? "").trim();
  const res = await createMandate(ctx.workspaceId, {
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
      const card = await issueCardForMandate(m, { name: m.name, email: ctx.email });
      await attachCard(ctx.workspaceId, m.id, card);
    } catch (e) {
      await recordCardError(ctx.workspaceId, m.id, (e as Error).message);
    }
  }
  revalidatePath("/");
  redirect(`/mandates/${m.id}?new=1`);
}

export async function simulatePurchaseAction(form: FormData) {
  const ctx = await requireCtx();
  const id = String(form.get("mandateId") ?? "");
  if (!isUuid(id)) return;
  const m = await getMandate(ctx.workspaceId, id);
  if (!m) return;
  const amount = toMinor(num(form.get("amount")));
  const merchant = String(form.get("merchant") ?? "").trim() || "unknown merchant";
  const purpose = String(form.get("purpose") ?? "").trim();
  const category = String(form.get("category") ?? "").trim();
  const viaStripe = form.get("viaStripe") === "on" && stripeEnabled() && m.stripeCardId;
  if (viaStripe) {
    try { await simulateStripeAuthorization(m.stripeCardId!, amount, merchant); } catch (e) { console.error((e as Error).message); }
  } else {
    await authorize(m, { amount, merchant, purpose, category }, "simulation", { actor: ctx.email });
  }
  revalidatePath(`/mandates/${id}`);
  revalidatePath("/");
  revalidatePath("/approvals");
  revalidatePath("/ledger");
  redirect(`/mandates/${id}`);
}

export async function revokeMandateAction(form: FormData) {
  const ctx = await requireCtx();
  const id = String(form.get("mandateId") ?? "");
  if (!isUuid(id)) return;
  const m = await getMandate(ctx.workspaceId, id);
  if (!m) return;
  if (m.stripeCardId && stripeEnabled()) { try { await deactivateCard(m.stripeCardId); } catch (e) { console.error((e as Error).message); } }
  await revokeMandate(ctx.workspaceId, id, ctx.email);
  revalidatePath("/");
  revalidatePath(`/mandates/${id}`);
  redirect(`/mandates/${id}`);
}

export async function decideApprovalAction(form: FormData) {
  const ctx = await requireCtx();
  const id = String(form.get("approvalId") ?? "");
  if (!isUuid(id)) return;
  const decision = form.get("decision") === "approve" ? "approved" : "denied";
  await decideApproval(ctx.workspaceId, id, decision, ctx.email);
  revalidatePath("/approvals");
  revalidatePath("/");
  revalidatePath("/ledger");
  redirect("/approvals");
}

export async function sendTestNotificationAction() {
  await requireCtx();
  const { sendTest, configuredChannels } = await import("@/lib/notify");
  if (configuredChannels().length === 0) redirect("/settings?test=none");
  const outcomes = await sendTest();
  const failed = outcomes.filter((o) => !o.ok);
  redirect(failed.length ? `/settings?test=${encodeURIComponent(failed.map((f) => `${f.channel}: ${f.error}`).join("; "))}` : "/settings?test=ok");
}

export async function signOutAction() {
  await auth.api.signOut({ headers: await headers() });
  redirect("/sign-in");
}

export async function revokeOAuthClientAction(form: FormData) {
  const ctx = await requireCtx();
  const clientId = String(form.get("clientId") ?? "");
  if (!clientId) return;
  await revokeConnectedAgent(ctx.userId, clientId);
  revalidatePath("/settings");
  redirect("/settings?disconnected=1");
}
