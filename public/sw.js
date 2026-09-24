/* Mandate service worker: push notifications with one-tap actions.
   No caching of pages — this app is live data; the worker exists so the
   phone can show an approval request and act on it from the lock screen. */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: "Mandate", body: event.data ? event.data.text() : "" }; }
  const actions = [];
  if (data.approveUrl) actions.push({ action: "approve", title: "Approve once" });
  if (data.denyUrl) actions.push({ action: "deny", title: "Deny" });
  event.waitUntil(self.registration.showNotification(data.title || "Mandate", {
    body: data.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    requireInteraction: Boolean(data.approveUrl),
    data,
    actions,
  }));
});

// An action button decides in the background through the signed one-tap
// endpoint (the signature in the URL is the authority — no cookie needed),
// then replaces the notification with the outcome. Tapping the body opens
// the inbox.
self.addEventListener("notificationclick", (event) => {
  const n = event.notification;
  const d = n.data || {};
  n.close();
  if (event.action === "approve" || event.action === "deny") {
    const url = event.action === "approve" ? d.approveUrl : d.denyUrl;
    event.waitUntil((async () => {
      let text = "";
      try {
        const r = await fetch(url.replace(/\/a\//, "/api/approvals/onetap/"), { method: "POST" });
        const j = await r.json().catch(() => ({}));
        text = r.ok ? (event.action === "approve" ? "Approved once. The agent can retry now." : "Denied for 6 hours.") : (j.error || "Could not decide — open the inbox.");
      } catch { text = "Offline — open the inbox to decide."; }
      await self.registration.showNotification("Mandate", { body: text, icon: "/icons/icon-192.png", tag: (d.tag || "mandate") + ":done" });
    })());
    return;
  }
  const target = d.inboxUrl || d.url || "/approvals";
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) { if ("focus" in c) { await c.focus(); if ("navigate" in c) { try { await c.navigate(target); } catch {} } return; } }
    await self.clients.openWindow(target);
  })());
});
