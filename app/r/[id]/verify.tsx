"use client";

import { useState } from "react";

// Verifies the receipt in the reader's own browser: fetch the JSON, rebuild
// the canonical core, hash it, check the Ed25519 signature with WebCrypto
// against the public key from /.well-known/mandate-receipt-key. Nothing the
// page says is trusted — only the bytes and the key.

type State = { phase: "idle" } | { phase: "working" } | { phase: "done"; coreOk: boolean; sigOk: boolean; keyMatches: boolean; how: "browser" | "server"; detail?: string } | { phase: "error"; message: string };

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const obj = value as Record<string, unknown>;
  return "{" + Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") + "}";
}
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
function pemToDer(pem: string): ArrayBuffer { return b64(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")).buffer as ArrayBuffer; }

export function Verify({ jsonUrl, keyUrl, id }: { jsonUrl: string; keyUrl: string; id: string }) {
  const [st, setSt] = useState<State>({ phase: "idle" });
  async function run() {
    setSt({ phase: "working" });
    try {
      const [receipt, servedKey] = await Promise.all([fetch(jsonUrl, { cache: "no-store" }).then((r) => { if (!r.ok) throw new Error("Receipt could not be fetched (" + r.status + ")."); return r.json(); }), fetch(keyUrl, { cache: "no-store" }).then((r) => r.text())]);
      const { transaction, mandate, agent, approval, events, chain, signature } = receipt;
      const coreBytes = new TextEncoder().encode(canonical({ transaction, mandate, agent, approval, events, chain }));
      const coreHash = hex(await crypto.subtle.digest("SHA-256", coreBytes));
      const coreOk = coreHash === signature.coreHash;
      const message = `mandate-tx-receipt|${transaction.id}|${signature.coreHash}|${signature.signedAt}`;
      const keyMatches = servedKey.replace(/\s+/g, "") === String(signature.publicKeyPem).replace(/\s+/g, "");
      let sigOk = false;
      try {
        const key = await crypto.subtle.importKey("spki", pemToDer(servedKey), { name: "Ed25519" }, false, ["verify"]);
        sigOk = await crypto.subtle.verify({ name: "Ed25519" }, key, b64(signature.signature), new TextEncoder().encode(message));
        setSt({ phase: "done", coreOk, sigOk, keyMatches, how: "browser" });
      } catch {
        // Older browsers lack Ed25519 in WebCrypto: fall back to the server's verifier (still against the server's key).
        const v = await fetch(`/api/receipts/tx/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(receipt) }).then((r) => r.json());
        setSt({ phase: "done", coreOk: coreOk && v.coreOk, sigOk: Boolean(v.signatureValid), keyMatches, how: "server", detail: "This browser cannot verify Ed25519 itself; the server checked the signature." });
      }
    } catch (e) { setSt({ phase: "error", message: (e as Error).message }); }
  }
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="page-head" style={{ marginBottom: 6 }}>
        <div><div className="eyebrow">Verify this receipt</div><p className="muted" style={{ fontSize: 13.5, margin: "4px 0 0" }}>Your browser fetches the signed JSON and the server's public key, re-hashes the receipt and checks the Ed25519 signature. The page has no say in the answer.</p></div>
        <button className="btn secondary" onClick={run} disabled={st.phase === "working"}>{st.phase === "working" ? "Verifying…" : "Verify in my browser"}</button>
      </div>
      {st.phase === "done" && (
        <div className={`notice ${st.coreOk && st.sigOk && st.keyMatches ? "ok" : "bad"}`}>
          {st.coreOk && st.sigOk && st.keyMatches ? <><strong>Verified.</strong> The contents hash to what was signed, the signature is valid for the server's published key, and the key on the receipt is the key the server serves.</> : <><strong>Not verified.</strong> {!st.coreOk && "The contents do not match the signed hash. "}{!st.sigOk && "The signature does not verify. "}{!st.keyMatches && "The key on the receipt is not the one the server serves. "}</>}
          {st.detail && <div className="faint" style={{ fontSize: 12.5, marginTop: 4 }}>{st.detail}</div>}
        </div>
      )}
      {st.phase === "error" && <div className="notice bad">{st.message}</div>}
      <div className="faint" style={{ fontSize: 12, marginTop: 8 }}>Offline: <code>sha256(canonical(core))</code> must equal <code>signature.coreHash</code>; then Ed25519-verify <code>signature.message</code> with the key at <code>{keyUrl}</code>.</div>
    </div>
  );
}
