"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// "Approve with passkey": fetch a challenge that commits to this exact
// decision, have the browser's passkey sign it, send the assertion back.
// The server verifies against the registered key and records the
// signature with the decision, so the receipt proves a human decided.
function b64uToBuf(s: string) { const p = "=".repeat((4 - (s.length % 4)) % 4); return Uint8Array.from(atob((s + p).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)).buffer; }
function bufToB64u(b: ArrayBuffer) { return btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }

export function SignedDecision({ approvalId, decision, label, className }: { approvalId: string; decision: "approve" | "deny"; label: string; className: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const router = useRouter();
  const supported = typeof window !== "undefined" && "PublicKeyCredential" in window;
  if (!supported) return null;
  async function go() {
    setBusy(true); setMsg("");
    try {
      const opts = await fetch(`/api/approvals/${approvalId}/sign?d=${decision}`).then(async (r) => ({ status: r.status, body: await r.json() }));
      if (opts.status === 412) { setMsg("Add a passkey in Settings to sign approvals."); return; }
      if (opts.status !== 200) { setMsg(opts.body.error ?? "Could not start signing."); return; }
      const pk = opts.body.publicKey;
      const cred = (await navigator.credentials.get({ publicKey: { challenge: b64uToBuf(pk.challenge), rpId: pk.rpId, timeout: pk.timeout, userVerification: pk.userVerification, allowCredentials: pk.allowCredentials.map((c: { id: string; type: "public-key"; transports?: AuthenticatorTransport[] }) => ({ ...c, id: b64uToBuf(c.id) })) } })) as PublicKeyCredential | null;
      if (!cred) { setMsg("No passkey was used."); return; }
      const resp = cred.response as AuthenticatorAssertionResponse;
      const assertion = { id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults(), response: { clientDataJSON: bufToB64u(resp.clientDataJSON), authenticatorData: bufToB64u(resp.authenticatorData), signature: bufToB64u(resp.signature), userHandle: resp.userHandle ? bufToB64u(resp.userHandle) : undefined } };
      const r = await fetch(`/api/approvals/${approvalId}/sign`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ d: decision, assertion }) });
      const j = await r.json();
      if (!r.ok) { setMsg(j.error ?? "Signing failed."); return; }
      router.refresh();
    } catch (e) { setMsg((e as Error).name === "NotAllowedError" ? "Cancelled." : (e as Error).message); }
    finally { setBusy(false); }
  }
  return <span style={{ display: "inline-flex", flexDirection: "column", gap: 4 }}><button type="button" className={className} onClick={go} disabled={busy} title="Sign this decision with your passkey; the receipt will prove a human on a registered device decided.">{busy ? "Signing…" : label}</button>{msg && <span className="faint" style={{ fontSize: 11.5 }}>{msg}</span>}</span>;
}
