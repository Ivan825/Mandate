"use client";

import { useEffect } from "react";

// Registers the service worker for signed-in people so the app can be
// installed and can receive push. It caches nothing.
export function PwaRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => { /* private mode, unsupported, or blocked */ });
  }, []);
  return null;
}
