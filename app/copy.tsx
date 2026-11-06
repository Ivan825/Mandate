"use client";

import { useState } from "react";

// A one-line command with a copy button, for the public pages.
export function CopyLine({ text, label, prompt = "$" }: { text: string; label?: string; prompt?: string }) {
  const [done, setDone] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1600); } catch { /* clipboard blocked; the text is selectable */ }
  }
  return (
    <div className="copyline">
      {label && <span className="copyline-label">{label}</span>}
      <span className="copyline-prompt" aria-hidden>{prompt}</span>
      <code className="copyline-text">{text}</code>
      <button type="button" className="copyline-btn" onClick={copy} aria-label={`Copy: ${text}`}>{done ? "copied" : "copy"}</button>
    </div>
  );
}
