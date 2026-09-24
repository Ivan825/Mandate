"use client";

import { useEffect, useState } from "react";

type Device = { id: string; endpoint: string; userAgent: string; createdAt: string };
type Info = { enabled: boolean; publicKey: string | null; devices: Device[] };

function b64ToU8(b64: string) { const pad = "=".repeat((4 - (b64.length % 4)) % 4); const s = (b64 + pad).replace(/-/g, "+").replace(/_/g, "/"); return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }

// "Get approval requests on this device": subscribes this browser to push
// through the service worker and registers the subscription with Mandate.
export function PushPanel() {
  const [info, setInfo] = useState<Info | null>(null);
  const [mine, setMine] = useState<string | null>(null); // this browser's endpoint, if subscribed
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const supported = typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const iosNeedsInstall = typeof navigator !== "undefined" && /iPhone|iPad/.test(navigator.userAgent) && !(window.matchMedia?.("(display-mode: standalone)").matches);

  async function load() {
    const i: Info = await fetch("/api/push/subscribe").then((r) => r.json());
    setInfo(i);
    try { const reg = await navigator.serviceWorker.getRegistration("/"); const sub = await reg?.pushManager.getSubscription(); setMine(sub?.endpoint ?? null); } catch { setMine(null); }
  }
  useEffect(() => { if (supported) load(); else setInfo({ enabled: false, publicKey: null, devices: [] }); }, [supported]);

  async function enable() {
    if (!info?.publicKey) return;
    setBusy(true); setMsg("");
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { setMsg("Notifications were not allowed. Change it in the browser's site settings."); return; }
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(info.publicKey) });
      const r = await fetch("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sub.toJSON()) });
      if (!r.ok) { setMsg((await r.json()).error ?? "Could not register this device."); return; }
      setMsg("This device will get approval requests with Approve / Deny buttons.");
      await load();
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }
  async function disable(endpoint?: string, id?: string) {
    setBusy(true); setMsg("");
    try {
      if (!endpoint || endpoint === mine) { const reg = await navigator.serviceWorker.getRegistration("/"); const sub = await reg?.pushManager.getSubscription(); await sub?.unsubscribe(); }
      await fetch("/api/push/subscribe", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify(endpoint ? { endpoint } : { id }) });
      await load();
    } finally { setBusy(false); }
  }

  if (!info) return <p className="faint">Checking…</p>;
  if (!info.enabled) return <p className="muted">Push is not configured on this deployment (VAPID keys). Email and webhook channels above still work.</p>;
  if (!supported) return <p className="muted">This browser cannot receive push notifications. On iPhone, add Mandate to the Home Screen first, then come back here.</p>;
  return (
    <div className="card stack">
      {iosNeedsInstall && <div className="notice">On iPhone, push only works once Mandate is on the Home Screen: Share → Add to Home Screen, open it from there, then enable push.</div>}
      <div className="actions">
        {mine ? <button className="btn secondary sm" onClick={() => disable(mine)} disabled={busy}>Turn off on this device</button> : <button className="btn accent sm" onClick={enable} disabled={busy}>{busy ? "Enabling…" : "Get approval requests on this device"}</button>}
        <span className="faint" style={{ fontSize: 12.5 }}>{mine ? "This device is subscribed." : "Approve or deny straight from the notification, even from the lock screen."}</span>
      </div>
      {msg && <div className="notice" style={{ fontSize: 13.5 }}>{msg}</div>}
      {info.devices.length > 0 && (
        <table className="mini"><tbody>
          {info.devices.map((d) => <tr key={d.id}><td style={{ fontSize: 12.5 }}>{d.userAgent.slice(0, 70) || "device"}{d.endpoint === mine && <span className="pill ok" style={{ marginLeft: 8 }}>this device</span>}</td><td className="faint" style={{ fontSize: 12 }}>{new Date(d.createdAt).toLocaleDateString()}</td><td><button className="btn secondary sm" onClick={() => disable(d.endpoint, d.id)} disabled={busy}>Remove</button></td></tr>)}
        </tbody></table>
      )}
    </div>
  );
}
