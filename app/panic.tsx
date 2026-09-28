"use client";

import { useEffect, useRef, useState } from "react";

// The panic button. One click opens a small confirm; the second click
// freezes every agent in the workspace at once. Deliberately two clicks
// and never a JS confirm(): the browser dialog would block, and a single
// click in the wrong place should not stop a business.
export function PanicButton({ action }: { action: (form: FormData) => void | Promise<void> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, []);
  return (
    <details ref={ref} className="menu panic" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="btn danger sm" title="Freeze every agent in this workspace, on every rail, right now">Freeze</summary>
      <form action={action} className="menu-body form" style={{ minWidth: 280 }}>
        <div style={{ fontSize: 13.5 }}><strong>Stop every agent now?</strong> Every request in this workspace will be declined — cards, API, MCP and proxy — until you unfreeze. Nothing is revoked.</div>
        <div className="field"><label htmlFor="panic-reason">Why (optional)</label><input id="panic-reason" name="reason" placeholder="agent is looping" autoComplete="off" /></div>
        <button className="btn danger sm" type="submit">Yes, freeze everything</button>
      </form>
    </details>
  );
}
