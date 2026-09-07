import Link from "next/link";
import { requireCtx, can } from "@/lib/session";
import { listProviderKeys, listProxyKeys, recentCalls, revealProxyKey, PROVIDERS } from "@/lib/proxy";
import { listMandates } from "@/lib/service";
import { fmt, parseList, merchantMatches } from "@/lib/policy";
import { Pill, When } from "@/app/components";
import { addProviderKeyAction, removeProviderKeyAction, createProxyKeyAction, revokeProxyKeyAction } from "@/app/actions";
import { grantValid, sweepReveals } from "@/lib/reveal";
import { appUrl } from "@/lib/env";

export default async function ProxyPage({ searchParams }: { searchParams: Promise<{ added?: string; error?: string; reveal?: string; g?: string }> }) {
  const ctx = await requireCtx();
  const { added, error, reveal, g } = await searchParams;
  await sweepReveals();
  const base = appUrl();
  const [providerKeys, proxyKeys, calls, mandates, mayManage] = await Promise.all([
    listProviderKeys(ctx.workspaceId), listProxyKeys(ctx.workspaceId), recentCalls(ctx.workspaceId), listMandates(ctx.workspaceId, true), can({ proxy: ["manage"] }),
  ]);
  const revealed = reveal && /^[0-9a-f-]{36}$/i.test(reveal) && grantValid(reveal, g) ? await revealProxyKey(ctx.workspaceId, reveal) : null;
  const usdMandates = mandates.filter((m) => m.m.currency === "USD");
  // Proxy calls are authorised as purchases at "OpenAI", "Anthropic" or
  // "Google Gemini". A mandate whose merchant list leaves those out would
  // decline every call, so say so before a key is issued.
  const providerNames = Object.values(PROVIDERS).map((p) => p.name);
  const blocksProviders = (allowed: string) => { const list = parseList(allowed); return list.length > 0 && !providerNames.some((n) => list.some((pat) => merchantMatches(pat, n))); };

  return (
    <div style={{ maxWidth: 900 }}>
      <div className="page-head">
        <div>
          <div className="eyebrow">API-key proxy</div>
          <h1>Meter what your agents spend on OpenAI, Anthropic and Gemini</h1>
          <p className="muted">Store your real provider keys here, encrypted. Hand each agent a proxy key bound to a mandate instead. Every call is priced from the request, decided against the mandate before it is forwarded, and settled on the tokens the provider actually billed. The agent never sees your real key.</p>
        </div>
      </div>

      {revealed && (
        <div className="notice" style={{ marginBottom: 20 }}>
          <strong>Proxy key issued. Copy it now — it is shown only this once.</strong>
          <div className="token" style={{ margin: "10px 0 6px" }}>{revealed}</div>
          Use it exactly where the provider's SDK expects its own key, and point the SDK's base URL at Mandate (below).
        </div>
      )}
      {added === "provider" && <div className="notice ok" style={{ marginBottom: 16 }}>Provider key stored (encrypted). Now issue a proxy key for an agent.</div>}
      {error && <div className="notice bad" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="grid-2" style={{ marginBottom: 24 }}>
        <div className="card stack">
          <div className="eyebrow">Your provider keys (encrypted at rest)</div>
          {providerKeys.length === 0 ? <p className="muted" style={{ margin: 0 }}>None yet.</p> : (
            <table style={{ minWidth: 0 }}>
              <tbody>
                {providerKeys.map((k) => (
                  <tr key={k.id}><td>{PROVIDERS[k.provider as keyof typeof PROVIDERS]?.name ?? k.provider}</td><td className="mono faint">····{k.hint}</td><td>{k.label}</td><td>{mayManage && <form action={removeProviderKeyAction}><input type="hidden" name="id" value={k.id} /><button className="btn secondary sm" type="submit">Remove</button></form>}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          {mayManage && (
            <form action={addProviderKeyAction} className="form">
              <div className="row">
                <div className="field"><label htmlFor="provider">Provider</label>
                  <select id="provider" name="provider" defaultValue="openai"><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="gemini">Google Gemini</option></select>
                </div>
                <div className="field"><label htmlFor="label">Label</label><input id="label" name="label" placeholder="personal, team…" /></div>
              </div>
              <div className="field"><label htmlFor="key">API key</label><input id="key" name="key" type="password" required placeholder="sk-… / sk-ant-… / AIza…" autoComplete="off" /></div>
              <div className="actions"><button className="btn secondary" type="submit">Store encrypted</button></div>
            </form>
          )}
        </div>

        <div className="card stack">
          <div className="eyebrow">Issue a proxy key to an agent</div>
          {providerKeys.length === 0 || usdMandates.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>{providerKeys.length === 0 ? "Store a provider key first." : "Issue a USD mandate first; the proxy prices calls in USD."} {usdMandates.length === 0 && <Link href="/mandates/new">Issue mandate</Link>}</p>
          ) : mayManage ? (
            <form action={createProxyKeyAction} className="form">
              <div className="field"><label htmlFor="name">Name</label><input id="name" name="name" required placeholder="e.g. Claude Code on the work laptop" /></div>
              <div className="field"><label htmlFor="mandateId">Mandate (limits that apply)</label>
                <select id="mandateId" name="mandateId">{usdMandates.map((m) => <option key={m.m.id} value={m.m.id}>{m.m.name} · {m.agentName} · {fmt(m.m.dailyLimit, "USD")}/day{blocksProviders(m.m.allowedMerchants) ? " · ⚠ merchant list excludes providers" : ""}</option>)}</select>
                <span className="hint">Calls are recorded as purchases at {providerNames.join(", ")}. If the mandate restricts merchants, include the provider's name (or leave the list empty).</span>
              </div>
              <div className="field"><label htmlFor="providerKeyId">Provider key</label>
                <select id="providerKeyId" name="providerKeyId">{providerKeys.map((k) => <option key={k.id} value={k.id}>{PROVIDERS[k.provider as keyof typeof PROVIDERS]?.name ?? k.provider} ····{k.hint} {k.label && `(${k.label})`}</option>)}</select>
              </div>
              <div className="actions"><button className="btn accent" type="submit">Issue proxy key</button></div>
            </form>
          ) : <p className="faint">Only owners and admins issue proxy keys.</p>}
        </div>
      </div>

      <h2 style={{ marginBottom: 10 }}>Proxy keys</h2>
      <div className="tbl" style={{ marginBottom: 24 }}>
        <table>
          <thead><tr><th>Name</th><th>Provider</th><th>Mandate</th><th>Key</th><th>Status</th><th>Last used</th><th></th></tr></thead>
          <tbody>
            {proxyKeys.length === 0 && <tr><td colSpan={7} className="empty">No proxy keys yet.</td></tr>}
            {proxyKeys.map(({ k, mandateName, provider, hint }) => (
              <tr key={k.id}><td>{k.name}</td><td>{PROVIDERS[provider as keyof typeof PROVIDERS]?.name ?? provider} <span className="faint mono">····{hint}</span></td><td>{mandateName}</td><td className="mono faint">{k.tokenPrefix}…</td><td><Pill v={k.status} /></td><td><When d={k.lastUsedAt} /></td>
                <td>{mayManage && k.status === "active" && <form action={revokeProxyKeyAction}><input type="hidden" name="id" value={k.id} /><button className="btn danger sm" type="submit">Revoke</button></form>}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 style={{ marginBottom: 10 }}>Point the SDK at Mandate</h2>
      <div className="card" style={{ marginBottom: 24 }}>
        <pre>{`# OpenAI SDKs
OPENAI_BASE_URL=${base}/api/proxy/openai
OPENAI_API_KEY=mpx_…

# Anthropic SDKs
ANTHROPIC_BASE_URL=${base}/api/proxy/anthropic
ANTHROPIC_API_KEY=mpx_…

# Google Gemini (google-genai)
client = genai.Client(api_key="mpx_…", http_options={"base_url": "${base}/api/proxy/gemini"})`}</pre>
        <p className="muted" style={{ marginTop: 10 }}>A call that would exceed the mandate returns the provider's error shape with status 403 (declined) or 402 (needs your approval), so the SDK raises normally and the agent can tell the user. Streaming works unchanged; usage is settled when the stream ends.</p>
      </div>

      <h2 style={{ marginBottom: 10 }}>Recent calls</h2>
      <div className="tbl">
        <table>
          <thead><tr><th>When</th><th>Key</th><th>Model</th><th className="r">Estimated</th><th className="r">Settled</th><th>Tokens in / out</th><th>Decision</th><th>Upstream</th></tr></thead>
          <tbody>
            {calls.length === 0 && <tr><td colSpan={8} className="empty">No calls yet.</td></tr>}
            {calls.map(({ c, keyName }) => (
              <tr key={c.id}><td><When d={c.createdAt} /></td><td>{keyName}</td><td className="mono" style={{ fontSize: 12.5 }}>{c.model}{c.streamed ? " ·stream" : ""}</td><td className="r num">{fmt(c.estimatedAmount, "USD")}</td><td className="r num">{c.actualAmount == null ? <span className="faint">—</span> : fmt(c.actualAmount, "USD")}</td><td className="num faint">{c.inputTokens ?? "–"} / {c.outputTokens ?? "–"}</td><td><Pill v={c.decision} /></td><td className="mono faint">{c.upstreamStatus ?? ""}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
