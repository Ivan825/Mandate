"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { createAgent, createMandate, getMandate, authorize, revokeMandate, decideApproval, attachCard, recordCardError, getCardholderProfile, saveCardholderProfile, captureTransaction, voidTransaction, saveWorkspaceSettings, pauseMandate, resumeMandate, raiseLimit, withdrawRaise, shareTransaction, unshareTransaction } from "@/lib/service";
import { issueCardForMandate, deactivateCard, stripeEnabled, simulateStripeAuthorization, cardholderProblem, ensureCardholder, issuingRegion, createTopupSession, freezeCard } from "@/lib/stripe";
import { endOfLocalDay } from "@/lib/policy";
import { toMinor as toMinorIn } from "@/lib/money";
import { requireCtx, requirePermission, can } from "@/lib/session";
import { auth } from "@/lib/auth";
import { revokeConnectedAgent, bindClientWorkspace } from "@/lib/connections";
import { grant } from "@/lib/reveal";

// Every mutating action resolves the caller's workspace from the session
// first; ids from forms are only ever used inside that workspace.

function num(v: FormDataEntryValue | null, fallback = 0): number {
  const n = parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : fallback;
}
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
  const timezone = String(form.get("timezone") ?? "UTC");
  const approvalRaw = String(form.get("approvalAbove") ?? "").trim();
  const expiresRaw = String(form.get("expiresAt") ?? "").trim();
  const currency = String(form.get("currency") ?? "USD").toUpperCase();
  const minor = (v: FormDataEntryValue | null) => toMinorIn(num(v), currency);
  const holdPolicyRaw = String(form.get("holdPolicy") ?? "capture");
  const res = await createMandate(ctx.workspaceId, {
    agentId,
    name: String(form.get("name") ?? ""),
    currency,
    perTxnLimit: minor(form.get("perTxnLimit")),
    dailyLimit: minor(form.get("dailyLimit")),
    totalLimit: minor(form.get("totalLimit")),
    approvalAbove: approvalRaw === "" ? null : minor(approvalRaw),
    allowedMerchants: lines(form.get("allowedMerchants")),
    blockedCategories: lines(form.get("blockedCategories")),
    activeHoursStart: Math.floor(num(form.get("activeHoursStart"), 0)),
    activeHoursEnd: Math.floor(num(form.get("activeHoursEnd"), 24)),
    timezone,
    expiresAt: /^\d{4}-\d{2}-\d{2}$/.test(expiresRaw) ? endOfLocalDay(expiresRaw, timezone) : null,
    holdTtlHours: Math.floor(num(form.get("holdTtlHours"), 24)),
    holdPolicy: holdPolicyRaw === "release" ? "release" : "capture",
  });
  if (!res.ok) return { errors: res.errors, values };
  const m = res.mandate;
  if (form.get("issueCard") === "on" && stripeEnabled()) {
    const profile = await getCardholderProfile(ctx.workspaceId);
    const problem = cardholderProblem(profile);
    const region = issuingRegion();
    if (problem) await recordCardError(ctx.workspaceId, m.id, problem);
    else if (m.currency !== region.currency) await recordCardError(ctx.workspaceId, m.id, `Cards are issued in ${region.currency}; this mandate is in ${m.currency}. Issue a ${region.currency} mandate for a card.`);
    else {
      try {
        const cardholderId = await ensureCardholder(profile!, ctx.workspaceId);
        if (cardholderId !== profile!.stripeCardholderId) await saveCardholderProfile(ctx.workspaceId, { ...profile!, stripeCardholderId: cardholderId });
        const card = await issueCardForMandate(m, cardholderId);
        await attachCard(ctx.workspaceId, m.id, card);
      } catch (e) {
        await recordCardError(ctx.workspaceId, m.id, (e as Error).message);
      }
    }
  }
  revalidatePath("/");
  const next = String(form.get("next") ?? "");
  if (next === "connect") redirect(`/connect?rail=${encodeURIComponent(String(form.get("rail") ?? "python"))}&mandate=${m.id}&g=${grant(m.id)}`);
  redirect(`/mandates/${m.id}?new=1&g=${grant(m.id)}`);
}

export async function simulatePurchaseAction(form: FormData) {
  const ctx = await requirePermission({ mandate: ["try"] }, "test purchases");
  const id = String(form.get("mandateId") ?? "");
  if (!isUuid(id)) return;
  const m = await getMandate(ctx.workspaceId, id);
  if (!m) return;
  const amount = toMinorIn(num(form.get("amount")), m.currency);
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

// The owner settles a hold the agent didn't: capture what was paid (in the
// mandate's major units, as typed) or void it.
export async function settleHoldAction(form: FormData) {
  const ctx = await requirePermission({ mandate: ["try"] }, "settling holds");
  const mandateId = String(form.get("mandateId") ?? "");
  const transactionId = String(form.get("transactionId") ?? "");
  if (!isUuid(mandateId) || !isUuid(transactionId)) return;
  const m = await getMandate(ctx.workspaceId, mandateId);
  if (!m) return;
  const back = String(form.get("back") ?? `/mandates/${mandateId}`);
  const kind = form.get("kind") === "void" ? "void" : "capture";
  const note = String(form.get("note") ?? "").trim();
  const r = kind === "void"
    ? await voidTransaction({ workspaceId: ctx.workspaceId, mandateId }, transactionId, { by: ctx.email, reason: note })
    : await captureTransaction({ workspaceId: ctx.workspaceId, mandateId }, transactionId, { amount: String(form.get("amount") ?? "").trim() === "" ? undefined : toMinorIn(num(form.get("amount")), m.currency), by: ctx.email, note });
  revalidatePath(back);
  revalidatePath("/");
  redirect(r.ok ? back : `${back}${back.includes("?") ? "&" : "?"}error=${encodeURIComponent(r.message)}`);
}

// ---------- Event webhooks (workspace-level) ----------

const WEBHOOKS = "/settings/webhooks";

export async function addWebhookEndpointAction(form: FormData) {
  const ctx = await requirePermission({ workspace: ["settings"] }, "managing event webhooks");
  const { addEndpoint } = await import("@/lib/webhooks");
  const r = await addEndpoint(ctx.workspaceId, { url: String(form.get("url") ?? ""), description: String(form.get("description") ?? ""), events: String(form.get("events") ?? "*") }, ctx.email);
  if (!r.ok) redirect(`${WEBHOOKS}?error=${encodeURIComponent(r.error)}`);
  redirect(`${WEBHOOKS}?reveal=${r.endpoint.id}&g=${grant(r.endpoint.id)}`);
}

export async function rotateWebhookSecretAction(form: FormData) {
  const ctx = await requirePermission({ workspace: ["settings"] }, "managing event webhooks");
  const { rotateEndpointSecret } = await import("@/lib/webhooks");
  const id = String(form.get("id") ?? "");
  if (!isUuid(id)) return;
  const s = await rotateEndpointSecret(ctx.workspaceId, id, ctx.email);
  if (!s) redirect(`${WEBHOOKS}?error=${encodeURIComponent("No such endpoint.")}`);
  redirect(`${WEBHOOKS}?reveal=${id}&g=${grant(id)}`);
}

export async function toggleWebhookEndpointAction(form: FormData) {
  const ctx = await requirePermission({ workspace: ["settings"] }, "managing event webhooks");
  const { setEndpointEnabled } = await import("@/lib/webhooks");
  const id = String(form.get("id") ?? "");
  if (!isUuid(id)) return;
  await setEndpointEnabled(ctx.workspaceId, id, form.get("enabled") === "1", ctx.email);
  revalidatePath(WEBHOOKS);
  redirect(WEBHOOKS);
}

export async function removeWebhookEndpointAction(form: FormData) {
  const ctx = await requirePermission({ workspace: ["settings"] }, "managing event webhooks");
  const { removeEndpoint } = await import("@/lib/webhooks");
  const id = String(form.get("id") ?? "");
  if (!isUuid(id)) return;
  await removeEndpoint(ctx.workspaceId, id, ctx.email);
  revalidatePath(WEBHOOKS);
  redirect(`${WEBHOOKS}?removed=1`);
}

export async function testWebhookEndpointAction(form: FormData) {
  const ctx = await requirePermission({ workspace: ["settings"] }, "managing event webhooks");
  const { rateLimit } = await import("@/lib/ratelimit");
  if (!(await rateLimit(`user:${ctx.userId}:webhook-test`, 20, 3600)).ok) redirect(`${WEBHOOKS}?error=${encodeURIComponent("Too many test events this hour.")}`);
  const { sendTestEvent } = await import("@/lib/webhooks");
  const id = String(form.get("id") ?? "");
  if (!isUuid(id)) return;
  const r = await sendTestEvent(ctx.workspaceId, id, ctx.email);
  revalidatePath(WEBHOOKS);
  redirect(r.ok ? `${WEBHOOKS}?test=ok` : `${WEBHOOKS}?test=${encodeURIComponent(r.error ?? `HTTP ${r.status}`)}`);
}

export async function retryWebhookDeliveryAction(form: FormData) {
  const ctx = await requirePermission({ workspace: ["settings"] }, "managing event webhooks");
  const { retryDelivery } = await import("@/lib/webhooks");
  const id = String(form.get("id") ?? "");
  if (!isUuid(id)) return;
  await retryDelivery(ctx.workspaceId, id);
  revalidatePath(WEBHOOKS);
  redirect(WEBHOOKS);
}

// ---------- Notes ----------

export async function addNoteAction(form: FormData) {
  const ctx = await requireCtx();
  if (ctx.role === "viewer") redirect("/activity?error=" + encodeURIComponent("Viewers can read notes but not add them."));
  const { addNote } = await import("@/lib/activity");
  const type = String(form.get("targetType") ?? "");
  const id = String(form.get("targetId") ?? "");
  const back = String(form.get("back") ?? "/activity");
  if (!["transaction", "approval", "event"].includes(type) || !isUuid(id)) redirect(back);
  await addNote(ctx.workspaceId, { type: type as "transaction" | "approval" | "event", id }, String(form.get("body") ?? ""), { id: ctx.userId, email: ctx.email });
  revalidatePath(back.split("?")[0]);
  redirect(back);
}

export async function removeNoteAction(form: FormData) {
  const ctx = await requireCtx();
  const { removeNote } = await import("@/lib/activity");
  const id = String(form.get("id") ?? "");
  const back = String(form.get("back") ?? "/activity");
  if (isUuid(id)) await removeNote(ctx.workspaceId, id, ctx.userId);
  revalidatePath(back.split("?")[0]);
  redirect(back);
}

export async function saveWorkspaceSettingsAction(form: FormData) {
  const ctx = await requirePermission({ workspace: ["settings"] }, "workspace settings");
  try { await saveWorkspaceSettings(ctx.workspaceId, { currency: String(form.get("currency") ?? "USD") }, ctx.email); }
  catch (e) { redirect("/settings?error=" + encodeURIComponent((e as Error).message)); }
  revalidatePath("/settings");
  redirect("/settings?workspace=saved");
}

// ---------- Public receipts ----------

export async function shareReceiptAction(form: FormData) {
  const ctx = await requirePermission({ ledger: ["export"] }, "sharing receipts");
  const id = String(form.get("transactionId") ?? ""); const mandateId = String(form.get("mandateId") ?? "");
  if (!isUuid(id) || !isUuid(mandateId)) return;
  if (form.get("stop") === "1") await unshareTransaction(ctx.workspaceId, id, ctx.email);
  else await shareTransaction(ctx.workspaceId, id, ctx.email);
  revalidatePath(`/mandates/${mandateId}`);
  redirect(`/mandates/${mandateId}#tx-${id}`);
}

// ---------- Pause and temporary raise ----------

export async function pauseMandateAction(form: FormData) {
  const ctx = await requirePermission({ mandate: ["revoke"] }, "pausing mandates");
  const id = String(form.get("mandateId") ?? "");
  if (!isUuid(id)) return;
  const hours = num(form.get("hours"), 0);
  const until = hours > 0 ? new Date(Date.now() + Math.min(hours, 24 * 30) * 3600_000) : null;
  await pauseMandate(ctx.workspaceId, id, { until, by: ctx.email, reason: String(form.get("reason") ?? "") });
  revalidatePath(`/mandates/${id}`); revalidatePath("/");
  redirect(`/mandates/${id}`);
}

export async function resumeMandateAction(form: FormData) {
  const ctx = await requirePermission({ mandate: ["revoke"] }, "resuming mandates");
  const id = String(form.get("mandateId") ?? "");
  if (!isUuid(id)) return;
  await resumeMandate(ctx.workspaceId, id, ctx.email);
  revalidatePath(`/mandates/${id}`); revalidatePath("/");
  redirect(`/mandates/${id}`);
}

export async function raiseLimitAction(form: FormData) {
  const ctx = await requirePermission({ mandate: ["issue"] }, "raising limits");
  const id = String(form.get("mandateId") ?? "");
  if (!isUuid(id)) return;
  const m = await getMandate(ctx.workspaceId, id);
  if (!m) return;
  const hours = Math.max(0, num(form.get("hours"), 24));
  const r = await raiseLimit(ctx.workspaceId, id, { field: String(form.get("field") ?? ""), amount: toMinorIn(num(form.get("amount")), m.currency), endsAt: new Date(Date.now() + hours * 3600_000), reason: String(form.get("reason") ?? ""), by: ctx.email });
  revalidatePath(`/mandates/${id}`); revalidatePath("/");
  redirect(r.ok ? `/mandates/${id}?raised=1` : `/mandates/${id}?error=${encodeURIComponent(r.error)}`);
}

export async function withdrawRaiseAction(form: FormData) {
  const ctx = await requirePermission({ mandate: ["issue"] }, "withdrawing raises");
  const id = String(form.get("mandateId") ?? ""); const oid = String(form.get("overrideId") ?? "");
  if (!isUuid(id) || !isUuid(oid)) return;
  await withdrawRaise(ctx.workspaceId, id, oid, ctx.email);
  revalidatePath(`/mandates/${id}`); revalidatePath("/");
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
  const { rateLimit } = await import("@/lib/ratelimit");
  if (!(await rateLimit(`user:${ctx.userId}:notify-test`, 10, 3600)).ok) redirect("/settings?error=" + encodeURIComponent("Too many test notifications this hour."));
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
  if (!["email", "webhook"].includes(type)) return;
  const r = await addChannel(ctx.userId, type as "email" | "webhook", String(form.get("target") ?? ""), String(form.get("label") ?? ""));
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
  await revokeConnectedAgent(ctx.userId, clientId, ctx.workspaceId);
  revalidatePath("/settings");
  redirect("/settings?disconnected=1");
}

// Consent page, right after Better Auth has recorded the consent: pin the
// agent to the workspace the person is looking at. The scopes are read from
// the stored consent, not from the page, so a hand-built call cannot claim
// less than was granted. Only roles that can act on mandates may bind an
// agent that spends.
export async function bindAgentAction(clientId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await requireCtx();
  if (!clientId || clientId.length > 200) return { ok: false, error: "Missing client id." };
  const { db, schema } = await import("@/lib/db");
  const { and, eq } = await import("drizzle-orm");
  const [consent] = await db.select({ scopes: schema.oauthConsent.scopes }).from(schema.oauthConsent).where(and(eq(schema.oauthConsent.userId, ctx.userId), eq(schema.oauthConsent.clientId, clientId))).limit(1);
  if (!consent) return { ok: false, error: "No consent on record for this agent; allow it first." };
  if ((consent.scopes ?? []).includes("mandate:spend") && !(await can({ mandate: ["try"] }))) {
    await revokeConnectedAgent(ctx.userId, clientId, ctx.workspaceId);
    return { ok: false, error: `Your role in ${ctx.workspaceName} (${ctx.role}) cannot let an agent spend, so the connection was withdrawn. Switch to a workspace where you are an owner or admin, or ask the agent for read-only access.` };
  }
  await bindClientWorkspace(ctx.userId, clientId, ctx.workspaceId);
  return { ok: true };
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
  const { rateLimit } = await import("@/lib/ratelimit");
  if (!(await rateLimit(`user:${ctx.userId}:invite`, 20, 3600)).ok) redirect("/members?error=" + encodeURIComponent("Too many invitations this hour; try again later."));
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

// Ownership moves as one step: the chosen member becomes owner, the current
// owner steps down to admin. Only an owner may do this, and only to a member
// who is already in the workspace.
export async function transferOwnershipAction(form: FormData) {
  const ctx = await requireCtx();
  if (ctx.role !== "owner") redirect("/members?error=" + encodeURIComponent("Only the owner can transfer ownership."));
  const memberId = String(form.get("memberId") ?? "");
  if (!memberId) return;
  const { db, schema } = await import("@/lib/db");
  const { and, eq } = await import("drizzle-orm");
  const { recordEvent } = await import("@/lib/ledger");
  const [target] = await db.select().from(schema.member).where(and(eq(schema.member.id, memberId), eq(schema.member.organizationId, ctx.workspaceId))).limit(1);
  if (!target || target.userId === ctx.userId) redirect("/members?error=" + encodeURIComponent("Pick another member of this workspace."));
  await db.transaction(async (tx) => {
    await tx.update(schema.member).set({ role: "owner" }).where(eq(schema.member.id, target.id));
    await tx.update(schema.member).set({ role: "admin" }).where(and(eq(schema.member.organizationId, ctx.workspaceId), eq(schema.member.userId, ctx.userId)));
  });
  await recordEvent(ctx.workspaceId, "workspace.ownership_transferred", { from: ctx.userId, to: target.userId, by: ctx.email });
  revalidatePath("/", "layout");
  redirect("/members?transferred=1");
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
  const existing = await getCardholderProfile(ctx.workspaceId);
  // Terms acceptance is recorded once, with the time, address and browser
  // Stripe asks for; unticking later does not un-accept.
  const h = await headers();
  const accepting = form.get("acceptTerms") === "on" && !existing?.termsAcceptedAt;
  const { clientIp } = await import("@/lib/ratelimit");
  await saveCardholderProfile(ctx.workspaceId, {
    name: f("name").slice(0, 60), email: f("email") || ctx.email, phone: f("phone").slice(0, 20), dob: f("dob"), line1: f("line1").slice(0, 100), line2: f("line2").slice(0, 100), city: f("city").slice(0, 60), state: f("state").slice(0, 40), postalCode: f("postalCode").slice(0, 16), country,
    termsAcceptedAt: accepting ? new Date() : existing?.termsAcceptedAt ?? null,
    termsIp: accepting ? clientIp(new Request("http://x", { headers: h })) : existing?.termsIp ?? "",
    termsUserAgent: accepting ? (h.get("user-agent") ?? "").slice(0, 200) : existing?.termsUserAgent ?? "",
    // The Stripe cardholder carries the old details; a changed address or
    // name means a new cardholder next time a card is issued.
    stripeCardholderId: existing && existing.name === f("name").slice(0, 60) && existing.line1 === f("line1").slice(0, 100) && existing.postalCode === f("postalCode").slice(0, 16) && existing.country === country ? existing.stripeCardholderId : null,
    cardholderStatus: existing?.cardholderStatus ?? "", cardholderRequirements: existing?.cardholderRequirements ?? "[]",
  });
  revalidatePath("/settings");
  redirect("/settings?cardholder=saved");
}

export async function freezeCardAction(form: FormData) {
  const ctx = await requirePermission({ mandate: ["revoke"] }, "freezing cards");
  const id = String(form.get("mandateId") ?? "");
  const frozen = form.get("frozen") === "1";
  if (!isUuid(id)) return;
  const m = await getMandate(ctx.workspaceId, id);
  if (!m?.stripeCardId || !stripeEnabled()) return;
  try {
    await freezeCard(m.stripeCardId, frozen);
    const { setCardFrozen } = await import("@/lib/service");
    await setCardFrozen(ctx.workspaceId, id, frozen, ctx.email);
  } catch (e) { redirect(`/mandates/${id}?error=` + encodeURIComponent((e as Error).message)); }
  revalidatePath(`/mandates/${id}`);
  redirect(`/mandates/${id}`);
}

// Money in. Owners and admins top up through Stripe Checkout; the credit
// lands when Stripe confirms payment (webhook or the success page).
export async function topupAction(form: FormData) {
  const ctx = await requirePermission({ workspace: ["settings"] }, "adding funds");
  if (!stripeEnabled()) redirect("/balance?error=" + encodeURIComponent("Stripe is not configured on this deployment."));
  const { MIN_TOPUP, MAX_TOPUP } = await import("@/lib/balance");
  const region = issuingRegion();
  const amount = toMinorIn(num(form.get("amount")), region.currency);
  if (!Number.isInteger(amount) || amount < MIN_TOPUP || amount > MAX_TOPUP) redirect("/balance?error=" + encodeURIComponent(`Top-ups are between ${(MIN_TOPUP / 100).toFixed(2)} and ${(MAX_TOPUP / 100).toFixed(2)} ${region.currency}.`));
  const { rateLimit } = await import("@/lib/ratelimit");
  if (!(await rateLimit(`user:${ctx.userId}:topup`, 10, 3600)).ok) redirect("/balance?error=" + encodeURIComponent("Too many top-up attempts this hour."));
  let url = "";
  try { url = await createTopupSession({ workspaceId: ctx.workspaceId, currency: region.currency, amount, email: ctx.email, by: ctx.email }); }
  catch (e) { redirect("/balance?error=" + encodeURIComponent((e as Error).message)); }
  redirect(url);
}

// ---------- Account and workspace lifecycle ----------

export async function leaveWorkspaceAction() {
  const ctx = await requireCtx();
  if (ctx.role === "owner") redirect("/settings?error=" + encodeURIComponent("An owner can't leave. On the Members page use \"Make owner\" on someone else first, or delete the workspace."));
  try { await auth.api.leaveOrganization({ body: { organizationId: ctx.workspaceId }, headers: await headers() }); }
  catch (e) { redirect("/settings?error=" + encodeURIComponent((e as Error).message)); }
  const { ensureActiveWorkspace } = await import("@/lib/session");
  await ensureActiveWorkspace();
  revalidatePath("/", "layout");
  redirect("/?left=1");
}

export async function deleteWorkspaceAction(form: FormData) {
  const ctx = await requireCtx();
  if (String(form.get("confirm") ?? "") !== ctx.workspaceName) redirect("/settings?error=" + encodeURIComponent("Type the workspace name exactly to confirm."));
  const { deleteWorkspace } = await import("@/lib/service");
  try { await deleteWorkspace(ctx.workspaceId, ctx.userId); }
  catch (e) { redirect("/settings?error=" + encodeURIComponent((e as Error).message)); }
  const { ensureActiveWorkspace } = await import("@/lib/session");
  await ensureActiveWorkspace();
  revalidatePath("/", "layout");
  redirect("/?deleted=1");
}

export async function deleteAccountAction(form: FormData) {
  const ctx = await requireCtx();
  if (String(form.get("confirm") ?? "").trim().toLowerCase() !== ctx.email.toLowerCase()) redirect("/settings?error=" + encodeURIComponent("Type your email exactly to confirm."));
  const { deleteAccount } = await import("@/lib/service");
  await deleteAccount(ctx.userId);
  try { await auth.api.signOut({ headers: await headers() }); } catch { /* session rows are already gone */ }
  redirect("/?goodbye=1");
}

export async function revokeSessionAction(form: FormData) {
  const ctx = await requireCtx();
  const id = String(form.get("id") ?? "");
  if (!id) return;
  // Session tokens never leave the server; the page identifies a session by id.
  const { db, schema } = await import("@/lib/db");
  const { and, eq } = await import("drizzle-orm");
  const [s] = await db.select({ token: schema.session.token }).from(schema.session).where(and(eq(schema.session.id, id), eq(schema.session.userId, ctx.userId))).limit(1);
  if (!s) return;
  try { await auth.api.revokeSession({ body: { token: s.token }, headers: await headers() }); } catch (e) { console.error((e as Error).message); }
  revalidatePath("/settings");
  redirect("/settings?sessions=revoked");
}

export async function revokeOtherSessionsAction() {
  await requireCtx();
  try { await auth.api.revokeOtherSessions({ headers: await headers() }); } catch (e) { console.error((e as Error).message); }
  revalidatePath("/settings");
  redirect("/settings?sessions=revoked");
}
