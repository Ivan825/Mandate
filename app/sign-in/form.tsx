"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export function SignInForm({ google, next, sent, error, emailDelivery }: { google: boolean; next: string; sent: boolean; error: string | null; emailDelivery: "email" | "console" }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">(sent ? "sent" : "idle");
  const [msg, setMsg] = useState<string>(error ?? "");

  async function sendLink(e: React.FormEvent) {
    e.preventDefault();
    setState("sending");
    const { error } = await authClient.signIn.magicLink({ email, callbackURL: next });
    if (error) { setState("error"); setMsg(error.message ?? "Could not send the link."); return; }
    setState("sent");
  }
  async function passkey() {
    const { error } = await authClient.signIn.passkey();
    if (error) { setState("error"); setMsg(error.message ?? "Passkey sign-in failed."); return; }
    window.location.href = next;
  }
  async function googleSignIn() {
    await authClient.signIn.social({ provider: "google", callbackURL: next });
  }

  return (
    <div className="card stack">
      {google && <button className="btn" type="button" onClick={googleSignIn} style={{ justifyContent: "center" }}>Continue with Google</button>}
      <button className="btn secondary" type="button" onClick={passkey} style={{ justifyContent: "center" }}>Use a passkey</button>
      <div className="eyebrow" style={{ textAlign: "center", margin: "4px 0" }}>or email me a link</div>
      {state === "sent" ? (
        <div className="notice ok">Link sent to <strong>{email || "your email"}</strong>. It's valid for 15 minutes.{emailDelivery === "console" && <> <span className="faint">(No email service configured: the link was printed to the server console.)</span></>}</div>
      ) : (
        <form onSubmit={sendLink} className="form">
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" required autoComplete="email webauthn" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </div>
          {state === "error" && <div className="notice bad">{msg}</div>}
          <button className="btn accent" type="submit" disabled={state === "sending"} style={{ justifyContent: "center" }}>{state === "sending" ? "Sending…" : "Send sign-in link"}</button>
        </form>
      )}
      <p className="faint" style={{ fontSize: 12.5, margin: 0 }}>First sign-in creates your personal workspace. You can add a passkey afterwards in Settings.</p>
    </div>
  );
}
