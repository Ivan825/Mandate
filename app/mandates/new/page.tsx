import Link from "next/link";
import { requireCtx, can } from "@/lib/session";
import { redirect } from "next/navigation";
import { listAgents } from "@/lib/service";
import { stripeEnabled } from "@/lib/stripe";
import { MandateForm } from "./form";

export default async function NewMandatePage({ searchParams }: { searchParams: Promise<{ agent?: string }> }) {
  const ctx = await requireCtx();
  if (!(await can({ mandate: ["issue"] }))) redirect("/?error=" + encodeURIComponent("Your role (" + ctx.role + ") cannot issue mandates here."));
  const { agent } = await searchParams;
  const agents = await listAgents(ctx.workspaceId);
  if (agents.length === 0) {
    return (
      <div style={{ maxWidth: 560 }}>
        <h1>Add an agent first</h1>
        <p className="muted" style={{ margin: "8px 0 16px" }}>A mandate is issued to an agent. <Link href="/agents/new">Create one</Link> and you'll come straight back here.</p>
      </div>
    );
  }
  const defaultAgent = agents.some((a) => a.id === agent) ? agent! : agents[0].id;
  return (
    <div style={{ maxWidth: 680 }}>
      <div className="eyebrow">Issue mandate</div>
      <h1>Sanction terms for this agent</h1>
      <p className="muted" style={{ margin: "8px 0 20px" }}>Think of it as a sanction letter: how much, per transaction and per day, where it may be spent, when, and the point above which you want to be asked. The agent receives a token that only works within these terms.</p>
      <MandateForm agents={agents.map((a) => ({ id: a.id, name: a.name }))} defaultAgent={defaultAgent} stripeOn={stripeEnabled()} />
    </div>
  );
}
