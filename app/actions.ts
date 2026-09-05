"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { createAgent, createMandate, getMandate, authorize, revokeMandate, decideApproval, attachCard, recordCardError, getCardholderProfile, saveCardholderProfile } from "@/lib/service";
import { issueCardForMandate, deactivateCard, stripeEnabled, simulateStripeAuthorization } from "@/lib/stripe";
import { endOfLocalDay } from "@/lib/policy";
import { requireCtx, requirePermission } from "@/lib/session";
import { auth } from "@/lib/auth";
import { revokeConnectedAgent } from "@/lib/connections";
import { grant } from "@/lib/reveal";

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
  const ctx = await requirePermission({ agent: ["create"] }, "adding agents");
  const name = String(form.get("name") ?? "").trim();
  if (!name) return;
  const a = await createAgent(ctx.workspaceId, { name, description: String(form.get("description") ?? "") });
  revalidatePath("/");
  redirect(`/mandates/new?agent=${a.id}`);
}

export type MandateFormState = { errors?: { field: string; message: string }[]; values?: Record<string, string> } | undefined;

export async function createMandateAction(_prev: MandateFormState, form: FormData): Promise<MandateFormState> {
  const ctx = await requirePermission({ mandate: ["issue"] }, "issuing mandates");
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
    const profile = await getCardholderProfile(ctx.workspaceId);
    if (!profile) await recordCardError(ctx.workspaceId, m.id, "No cardholder profile yet. Add your name and billing address in Settings, then issue a new mandate.");
    else {
      try {
        const card = await issueCardForMandate(m, { name: profile.name, email: profile.email, phone: profile.phone, dob: profile.dob, line1: profile.line1, line2: profile.line2, city: profile.city, state: profile.state, postalCode: profile.postalCode, country: profile.country });
        await attachCard(ctx.workspaceId, m.id, card);
      } catch (e) {
        await recordCardError(ctx.workspaceId, m.id, (e as Error).message);
      }
    }
  }
  revalidatePath("/");
  redirect(`/mandates/${m.id}?new=1&g=${grant(m.id)}`);
}

export async function simulatePurchaseAction(form: FormData) {
  const ctx = await requirePermission({ mandate: ["try"] }, "test purchases");
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
  const ctx = await requirePermission({ mandate: ["revoke"] }, "revoking mandates");
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
  const ctx = await requirePermission({ approval: ["decide"] }, "deciding requests");
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
  const ctx = await requireCtx();
  const { sendTest, listChannels } = await import("@/lib/notify");
  const channels = await listChannels(ctx.userId);
  if (channels.length === 0) redirect("/settings?test=none");
  const outcomes = await sendTest(channels);
  const failed = outcomes.filter((o) => !o.ok);
  redirect(failed.length ? `/settings?test=${encodeURIComponent(failed.map((f) => `${f.channel} ${f.target}: ${f.error}`).join("; "))}` : "/settings?test=ok");
}

export async function addChannelAction(form: FormData) {
  const ctx = await requireCtx();
  const { addChannel } = await import("@/lib/notify");
  const type = String(form.get("type") ?? "");
  if (!["telegram", "email", "webhook"].includes(type)) return;
  const r = await addChannel(ctx.userId, type as "telegram" | "email" | "webhook", String(form.get("target") ?? ""), String(form.get("label") ?? ""));
  revalidatePath("/settings");
  redirect(r.ok ? "/settings?channel=added" : "/settings?error=" + encodeURIComponent(r.error));
}

export async function removeChannelAction(form: FormData) {
  const ctx = await requireCtx();
  const { removeChannel } = await import("@/lib/notify");
  const id = String(form.get("id") ?? "");
  if (id) await removeChannel(ctx.userId, id);
  revalidatePath("/settings");
  redirect("/settings");
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

// ---------- Workspaces, members, invitations ----------

export async function switchWorkspaceAction(form: FormData) {
  await requireCtx();
  const organizationId = String(form.get("organizationId") ?? "");
  if (!organizationId) return;
  await auth.api.setActiveOrganization({ body: { organizationId }, headers: await headers() });
  revalidatePath("/", "layout");
  redirect("/");
}

export async function createWorkspaceAction(form: FormData) {
  const ctx = await requireCtx();
  const name = String(form.get("name") ?? "").trim().slice(0, 60);
  if (!name) return;
  const slug = `ws-${ctx.userId.slice(0, 6).toLowerCase()}-${Date.now().toString(36)}`;
  const org = await auth.api.createOrganization({ body: { name, slug }, headers: await headers() });
  if (org?.id) await auth.api.setActiveOrganization({ body: { organizationId: org.id }, headers: await headers() });
  revalidatePath("/", "layout");
  redirect("/members?created=1");
}

export async function inviteMemberAction(form: FormData) {
  const ctx = await requirePermission({ invitation: ["create"] }, "inviting members");
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const role = String(form.get("role") ?? "approver");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) redirect("/members?error=" + encodeURIComponent("Enter a valid email address."));
  if (!["admin", "approver", "viewer"].includes(role)) redirect("/members?error=" + encodeURIComponent("Pick a role."));
  try {
    await auth.api.createInvitation({ body: { email, role: role as "admin" | "approver" | "viewer", organizationId: ctx.workspaceId, resend: true }, headers: await headers() });
  } catch (e) {
    redirect("/members?error=" + encodeURIComponent((e as Error).message));
  }
  revalidatePath("/members");
  redirect("/members?invited=" + encodeURIComponent(email));
}

export async function cancelInvitationAction(form: FormData) {
  await requirePermission({ invitation: ["cancel"] }, "cancelling invitations");
  const invitationId = String(form.get("invitationId") ?? "");
  if (!invitationId) return;
  try { await auth.api.cancelInvitation({ body: { invitationId }, headers: await headers() }); } catch (e) { console.error((e as Error).message); }
  revalidatePath("/members");
  redirect("/members");
}

export async function updateMemberRoleAction(form: FormData) {
  const ctx = await requirePermission({ member: ["update"] }, "changing roles");
  const memberId = String(form.get("memberId") ?? "");
  const role = String(form.get("role") ?? "");
  if (!memberId || !["admin", "approver", "viewer"].includes(role)) return;
  try { await auth.api.updateMemberRole({ body: { memberId, role: role as "admin" | "approver" | "viewer", organizationId: ctx.workspaceId }, headers: await headers() }); } catch (e) { redirect("/members?error=" + encodeURIComponent((e as Error).message)); }
  revalidatePath("/members");
  redirect("/members");
}

export async function removeMemberAction(form: FormData) {
  const ctx = await requirePermission({ member: ["delete"] }, "removing members");
  const memberId = String(form.get("memberId") ?? "");
  if (!memberId) return;
  try { await auth.api.removeMember({ body: { memberIdOrEmail: memberId, organizationId: ctx.workspaceId }, headers: await headers() }); } catch (e) { redirect("/members?error=" + encodeURIComponent((e as Error).message)); }
  revalidatePath("/members");
  redirect("/members");
}

export async function acceptInvitationAction(form: FormData) {
  await requireCtx();
  const invitationId = String(form.get("invitationId") ?? "");
  if (!invitationId) return;
  try {
    const r = await auth.api.acceptInvitation({ body: { invitationId }, headers: await headers() });
    const orgId = (r as { invitation?: { organizationId?: string } } | null)?.invitation?.organizationId;
    if (orgId) await auth.api.setActiveOrganization({ body: { organizationId: orgId }, headers: await headers() });
  } catch (e) {
    redirect(`/invite/${invitationId}?error=` + encodeURIComponent((e as Error).message));
  }
  revalidatePath("/", "layout");
  redirect("/?joined=1");
}

// ---------- API-key proxy ----------

export async function addProviderKeyAction(form: FormData) {
  const ctx = await requirePermission({ proxy: ["manage"] }, "managing provider keys");
  const { addProviderKey, isProvider } = await import("@/lib/proxy");
  const provider = String(form.get("provider") ?? "");
  if (!isProvider(provider)) redirect("/proxy?error=" + encodeURIComponent("Pick a provider."));
  try { await addProviderKey(ctx.workspaceId, provider, String(form.get("key") ?? ""), String(form.get("label") ?? ""), ctx.email); }
  catch (e) { redirect("/proxy?error=" + encodeURIComponent((e as Error).message)); }
  revalidatePath("/proxy");
  redirect("/proxy?added=provider");
}

export async function removeProviderKeyAction(form: FormData) {
  const ctx = await requirePermission({ proxy: ["manage"] }, "managing provider keys");
  const { removeProviderKey } = await import("@/lib/proxy");
  const id = String(form.get("id") ?? "");
  if (id) await removeProviderKey(ctx.workspaceId, id, ctx.email);
  revalidatePath("/proxy");
  redirect("/proxy");
}

export async function createProxyKeyAction(form: FormData) {
  const ctx = await requirePermission({ proxy: ["manage"] }, "issuing proxy keys");
  const { createProxyKey } = await import("@/lib/proxy");
  try {
    // No revalidatePath here: the page is dynamic, and revalidating the same
    // route before redirecting renders it twice, consuming the show-once reveal.
    const k = await createProxyKey(ctx.workspaceId, { mandateId: String(form.get("mandateId") ?? ""), providerKeyId: String(form.get("providerKeyId") ?? ""), name: String(form.get("name") ?? "") }, ctx.email);
    redirect(`/proxy?reveal=${k.id}&g=${grant(k.id)}`);
  } catch (e) {
    if ((e as Error).message === "NEXT_REDIRECT" || String((e as { digest?: string }).digest ?? "").startsWith("NEXT_REDIRECT")) throw e;
    redirect("/proxy?error=" + encodeURIComponent((e as Error).message));
  }
}

export async function revokeProxyKeyAction(form: FormData) {
  const ctx = await requirePermission({ proxy: ["manage"] }, "revoking proxy keys");
  const { revokeProxyKey } = await import("@/lib/proxy");
  const id = String(form.get("id") ?? "");
  if (id) await revokeProxyKey(ctx.workspaceId, id, ctx.email);
  revalidatePath("/proxy");
  redirect("/proxy");
}

export async function saveCardholderProfileAction(form: FormData) {
  const ctx = await requirePermission({ workspace: ["settings"] }, "workspace settings");
  const f = (k: string) => String(form.get(k) ?? "").trim();
  const country = f("country").toUpperCase();
  if (!f("name") || !f("line1") || !f("city") || !f("postalCode") || !/^[A-Z]{2}$/.test(country)) redirect("/settings?error=" + encodeURIComponent("Name, address line, city, postal code and a 2-letter country are required."));
  if (f("dob") && !/^\d{4}-\d{2}-\d{2}$/.test(f("dob"))) redirect("/settings?error=" + encodeURIComponent("Date of birth must be YYYY-MM-DD."));
  await saveCardholderProfile(ctx.workspaceId, { name: f("name").slice(0, 60), email: f("email") || ctx.email, phone: f("phone").slice(0, 20), dob: f("dob"), line1: f("line1").slice(0, 100), line2: f("line2").slice(0, 100), city: f("city").slice(0, 60), state: f("state").slice(0, 40), postalCode: f("postalCode").slice(0, 16), country });
  revalidatePath("/settings");
  redirect("/settings?cardholder=saved");
}
