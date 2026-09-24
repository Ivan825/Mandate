"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";

// Pages are rendered on the server, so a decision an agent makes after the
// page loaded is invisible until the next render. This re-renders the current
// route from the server while the tab is in the foreground, and immediately
// when it comes back into view. router.refresh() keeps client state (form
// inputs, the stats filters) and swaps only the server-rendered parts.
//
// Polling only while visible keeps a tab left open overnight from spending
// function invocations for nobody.
const QUIET_PATHS = ["/sign-in", "/consent", "/terms", "/privacy", "/docs"];

export function LiveRefresh({ intervalMs = 15000 }: { intervalMs?: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const last = useRef(0);

  useEffect(() => {
    if (QUIET_PATHS.some((p) => pathname.startsWith(p))) return;
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      if (document.activeElement && ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) return; // don't yank the page while someone is typing
      const now = Date.now();
      if (now - last.current < 3000) return;
      last.current = now;
      router.refresh();
    };
    const timer = setInterval(refresh, intervalMs);
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("focus", onVisible); };
  }, [router, pathname, intervalMs]);

  return null;
}
