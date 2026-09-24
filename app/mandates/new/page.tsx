import Link from "next/link";
import { requireCtx, can } from "@/lib/session";
import { redirect } from "next/navigation";
import { listAgents, getWorkspaceSettings, getMandate } from "@/lib/service";
import { TEMPLATES, templateValues } from "@/lib/templates";
import { parseList } from "@/lib/policy";
import { toMajor } from "@/lib/money";
import { stripeEnabled, cardholderProblem, issuingRegion } from "@/lib/stripe";
import { getCardholderProfile } from "@/lib/service";
import { MandateForm } from "./form";

export default async function NewMandatePage({ searchParams }: { searchParams: Promise<{ agent?: string; template?: string; from?: string; next?: string; rail?: string }> }) {
  const ctx = await requireCtx();
  if (!(await can({ mandate: ["issue"] }))) redirect("/?error=" + encodeURIComponent("Your role (" + ctx.role + ") cannot issue mandates here."));
  const { agent, template, from, next, rail } = await searchParams;
  const agents = await listAgents(ctx.workspaceId);
  if (agents.length === 0) {
    return (
      <div style={{ maxWidth: 560 }}>
        <h1>Add an agent first</h1>
        <p className="muted" style={{ margin: "8px 0 16px" }}>A mandate is issued to an agent. <Link href="/agents/new">Create one</Link> and you'll come straight back here.</p>
      </div>
    );
  }
  const settings = await getWorkspaceSettings(ctx.workspaceId);
  // Pre-fill from a template, or from an existing mandate ("Duplicate").
  let initial: Record<string, string> | undefined;
  let initialLabel: string | undefined;
  let agentFromSource: string | undefined;
  const tpl = TEMPLATES.find((t) => t.key === template);
  if (tpl) { initial = templateValues(tpl, settings.currency); initialLabel = `the “${tpl.name}” template`; }
  else if (from && /^[0-9a-f-]{36}$/i.test(from)) {
    const src = await getMandate(ctx.workspaceId, from);
    if (src) {
      agentFromSource = src.agentId;
      initial = {
        name: src.name.replace(/\s*\(copy\)$/, "") + " (copy)", currency: src.currency,
        perTxnLimit: String(toMajor(src.perTxnLimit, src.currency)), dailyLimit: String(toMajor(src.dailyLimit, src.currency)), totalLimit: String(toMajor(src.totalLimit, src.currency)),
        approvalAbove: src.approvalAbove == null ? "" : String(toMajor(src.approvalAbove, src.currency)),
        allowedMerchants: parseList(src.allowedMerchants).join("\n"), blockedCategories: parseList(src.blockedCategories).join("\n"),
        activeHoursStart: String(src.activeHoursStart), activeHoursEnd: String(src.activeHoursEnd), timezone: src.timezone,
        expiresAt: src.expiresAt ? new Date(Math.max(Date.now() + 86400_000, new Date(src.expiresAt).getTime())).toISOString().slice(0, 10) : "",
        holdTtlHours: String(src.holdTtlHours), holdPolicy: src.holdPolicy,
      };
      initialLabel = `“${src.name}”`;
    }
  }
  const wanted = agentFromSource ?? agent;
  const defaultAgent = agents.some((a) => a.id === wanted) ? wanted! : agents[0].id;
  const q = (k: string) => `/mandates/new?${new URLSearchParams({ ...(agent ? { agent } : {}), template: k }).toString()}`;
  return (
    <div style={{ maxWidth: 680 }}>
      <div className="eyebrow">Issue mandate</div>
      <h1>Sanction terms for this agent</h1>
      <p className="muted" style={{ margin: "8px 0 16px" }}>Think of it as a sanction letter: how much, per transaction and per day, where it may be spent, when, and the point above which you want to be asked. The agent receives a token that only works within these terms.</p>
      <div className="tpl-row" aria-label="Start from a template">
        {TEMPLATES.map((t) => (
          <Link key={t.key} href={q(t.key)} className={`tpl${tpl?.key === t.key ? " on" : ""}`} title={t.blurb}>
            <span className="tpl-name">{t.name}</span><span className="tpl-who">{t.who}</span>
          </Link>
        ))}
      </div>
      <MandateForm key={`${template ?? ""}:${from ?? ""}`} agents={agents.map((a) => ({ id: a.id, name: a.name }))} defaultAgent={defaultAgent} stripeOn={stripeEnabled()} cardProblem={stripeEnabled() ? cardholderProblem(await getCardholderProfile(ctx.workspaceId)) : null} cardCurrency={issuingRegion().currency} defaultCurrency={settings.currency} initial={initial} initialLabel={initialLabel} next={next === "connect" ? { next, rail: rail ?? "python" } : undefined} />
    </div>
  );
}
