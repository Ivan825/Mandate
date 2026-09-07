"use client";

import { useEffect, useRef, useState } from "react";

// Shows a virtual card's number, expiry and CVC using Stripe's Issuing
// Elements: the details are fetched by Stripe.js straight from Stripe with a
// one-card ephemeral key, rendered inside Stripe-hosted iframes, and never
// pass through Mandate's servers. Loaded only when the person asks.

declare global { interface Window { Stripe?: (pk: string) => StripeJs } }
type StripeJs = {
  createEphemeralKeyNonce: (o: { issuingCard: string }) => Promise<{ nonce: string }>;
  elements: () => { create: (type: string, opts: Record<string, unknown>) => { mount: (sel: string) => void } };
};

function loadStripeJs(): Promise<void> {
  if (window.Stripe) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://js.stripe.com/v3/"; s.async = true;
    s.onload = () => resolve(); s.onerror = () => reject(new Error("Could not load Stripe.js"));
    document.head.appendChild(s);
  });
}

export function CardReveal({ mandateId, cardId, publishableKey, last4, exp }: { mandateId: string; cardId: string; publishableKey: string; last4: string; exp: string | null }) {
  const [state, setState] = useState<"idle" | "loading" | "shown" | "error">("idle");
  const [err, setErr] = useState("");
  const shown = useRef(false);

  async function reveal() {
    if (shown.current) return;
    setState("loading"); setErr("");
    try {
      await loadStripeJs();
      const stripe = window.Stripe!(publishableKey);
      const { nonce } = await stripe.createEphemeralKeyNonce({ issuingCard: cardId });
      const r = await fetch(`/api/cards/${mandateId}/ephemeral-key`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nonce }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Could not get a key.");
      const elements = stripe.elements();
      const style = { base: { color: getComputedStyle(document.documentElement).getPropertyValue("--ink").trim() || "#1B2230", fontFamily: "IBM Plex Mono, Menlo, monospace", fontSize: "15px" } };
      const common = { issuingCard: cardId, nonce, ephemeralKeySecret: j.secret, style };
      setState("shown");
      // Mount after the placeholders render.
      setTimeout(() => {
        elements.create("issuingCardNumberDisplay", common).mount("#card-number");
        elements.create("issuingCardExpiryDisplay", common).mount("#card-expiry");
        elements.create("issuingCardCvcDisplay", common).mount("#card-cvc");
        elements.create("issuingCardCopyButton", { toCopy: "number", style: { base: { fontSize: "13px" } } }).mount("#card-copy");
      }, 0);
      shown.current = true;
    } catch (e) { setState("error"); setErr((e as Error).message); }
  }

  useEffect(() => () => { shown.current = false; }, []);

  if (state === "shown") {
    return (
      <div className="cardface">
        <div className="row"><div><div className="eyebrow">Number</div><div id="card-number" className="cardfield" /></div><div id="card-copy" style={{ alignSelf: "end" }} /></div>
        <div className="row"><div><div className="eyebrow">Expiry</div><div id="card-expiry" className="cardfield" /></div><div><div className="eyebrow">CVC</div><div id="card-cvc" className="cardfield" /></div></div>
        <p className="faint" style={{ fontSize: 12, margin: 0 }}>Shown by Stripe directly; this reveal is in the ledger. Give the number to the agent's checkout only — never paste it into a prompt.</p>
      </div>
    );
  }
  return (
    <div className="actions">
      <span className="mono">···· {last4}{exp ? ` · ${exp}` : ""}</span>
      <button type="button" className="btn secondary sm" onClick={reveal} disabled={state === "loading"}>{state === "loading" ? "Fetching…" : "Show card details"}</button>
      {err && <span className="faint" style={{ color: "var(--bad)" }}>{err}</span>}
    </div>
  );
}
