"use client";

import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";

type Pk = { id: string; name?: string | null; createdAt: string | Date; deviceType?: string };

export function PasskeyPanel() {
  const [list, setList] = useState<Pk[]>([]);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const { data } = await authClient.passkey.listUserPasskeys();
    setList((data as Pk[]) ?? []);
  }
  useEffect(() => { load(); }, []);

  async function add() {
    setBusy(true); setMsg("");
    const { error } = await authClient.passkey.addPasskey({ name: navigator.platform || "This device" });
    setBusy(false);
    if (error) { setMsg(error.message ?? "Could not add a passkey."); return; }
    setMsg("Passkey added."); load();
  }
  async function remove(id: string) {
    await authClient.passkey.deletePasskey({ id });
    load();
  }

  return (
    <div className="card stack" style={{ marginBottom: 8 }}>
      {list.length === 0 ? <p className="muted" style={{ margin: 0 }}>No passkeys yet.</p> : (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {list.map((p) => <li key={p.id}>{p.name || "Passkey"} <span className="faint">· added {new Date(p.createdAt).toLocaleDateString()}</span> <button className="btn secondary sm" style={{ marginLeft: 8 }} onClick={() => remove(p.id)}>Remove</button></li>)}
        </ul>
      )}
      {msg && <div className="notice">{msg}</div>}
      <div><button className="btn" onClick={add} disabled={busy}>{busy ? "Waiting for your device…" : "Add a passkey for this device"}</button></div>
    </div>
  );
}
