import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { getCtx, can } from "@/lib/session";
import { listMandates } from "@/lib/service";
import { ConsentForm } from "./form";

// An MCP client (Claude, ChatGPT, Cursor, a custom agent) asked to connect.
// The person sees who is asking, which scopes, and which workspace the agent
// will be bound to, and decides.

function origin(u: string | null | undefined): string | null {
  if (!u) return null;
  try { return new URL(u).origin; } catch { return null; }
}

export default async function ConsentPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await getCtx();
  const q = await searchParams;
  if (!ctx) {
    const qs = new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => typeof e[1] === "string")).toString();
    redirect(`/sign-in?next=${encodeURIComponent("/consent?" + qs)}`);
  }
  const clientId = q.client_id ?? "";
  const [client] = clientId ? await db.select({ name: schema.oauthClient.name, uri: schema.oauthClient.uri, redirectUris: schema.oauthClient.redirectUris }).from(schema.oauthClient).where(eq(schema.oauthClient.clientId, clientId)).limit(1) : [];
  const scopes = (q.scope ?? "").split(/\s+/).filter(Boolean);
  const [mandates, canSpend] = await Promise.all([listMandates(ctx.workspaceId, true), can({ mandate: ["try"] })]);
  // Any client can register with any name; the redirect target is the one
  // thing it cannot fake, so show where the token will be sent.
  const redirectOrigins = Array.from(new Set((client?.redirectUris ?? []).map(origin).filter((o): o is string => !!o)));
  return (
    <div style={{ maxWidth: 520, margin: "48px auto" }}>
      <div className="eyebrow">Connect an agent</div>
      <h1 style={{ margin: "6px 0 8px" }}>{client?.name ?? "An application"} wants to use your mandates</h1>
      <p className="muted" style={{ marginBottom: 6 }}>{client?.uri && <span className="mono">{client.uri} · </span>}Signed in as {ctx.email}.</p>
      <p className="muted" style={{ marginBottom: 6 }}>It will be connected to <strong>{ctx.workspaceName}</strong> (your role: {ctx.role}) and will only ever see the mandates in that workspace, held to their limits on every purchase. To connect it to a different workspace later, disconnect it in Settings, switch workspaces from the top bar, and connect again.</p>
      {redirectOrigins.length > 0 && <p className="faint" style={{ fontSize: 12.5, marginBottom: 16 }}>Tokens will be sent to: <span className="mono">{redirectOrigins.join(", ")}</span>. If that is not where your agent runs, deny.</p>}
      <ConsentForm clientId={clientId} scopes={scopes} canSpend={canSpend} mandates={mandates.map((r) => ({ id: r.m.id, name: r.m.name, agent: r.agentName }))} />
    </div>
  );
}
