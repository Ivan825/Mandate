import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { getCtx } from "@/lib/session";
import { listMandates } from "@/lib/service";
import { ConsentForm } from "./form";

// An MCP client (Claude, ChatGPT, Cursor, a custom agent) asked to connect.
// The person sees who is asking and which scopes, and decides.

export default async function ConsentPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await getCtx();
  const q = await searchParams;
  if (!ctx) {
    const qs = new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => typeof e[1] === "string")).toString();
    redirect(`/sign-in?next=${encodeURIComponent("/consent?" + qs)}`);
  }
  const clientId = q.client_id ?? "";
  const [client] = clientId ? await db.select({ name: schema.oauthClient.name, uri: schema.oauthClient.uri }).from(schema.oauthClient).where(eq(schema.oauthClient.clientId, clientId)).limit(1) : [];
  const scopes = (q.scope ?? "").split(/\s+/).filter(Boolean);
  const mandates = await listMandates(ctx.workspaceId, true);
  return (
    <div style={{ maxWidth: 520, margin: "48px auto" }}>
      <div className="eyebrow">Connect an agent</div>
      <h1 style={{ margin: "6px 0 8px" }}>{client?.name ?? "An application"} wants to use your mandates</h1>
      <p className="muted" style={{ marginBottom: 16 }}>{client?.uri && <span className="mono">{client.uri} · </span>}Signed in as {ctx.email}. The agent will only ever see the mandates in this workspace and will be held to their limits on every purchase.</p>
      <ConsentForm scopes={scopes} mandates={mandates.map((r) => ({ id: r.m.id, name: r.m.name, agent: r.agentName }))} />
    </div>
  );
}
