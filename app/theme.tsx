"use client";

import { useEffect, useState } from "react";

// Light / dark / follow-the-system, remembered in a cookie so the server
// renders the right theme on the first byte (no flash) and the choice
// follows the person across their devices' sessions.

export type Theme = "light" | "dark" | "system";
const ORDER: Theme[] = ["system", "light", "dark"];
const LABEL: Record<Theme, string> = { system: "Auto", light: "Light", dark: "Dark" };
const GLYPH: Record<Theme, string> = { system: "◐", light: "☀", dark: "☾" };

export function ThemeToggle({ initial }: { initial: Theme }) {
  const [theme, setTheme] = useState<Theme>(initial);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") delete root.dataset.theme; else root.dataset.theme = theme;
    document.cookie = `theme=${theme}; path=/; max-age=31536000; samesite=lax`;
  }, [theme]);
  const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];
  return (
    <button type="button" className="theme" onClick={() => setTheme(next)} title={`Theme: ${LABEL[theme]}. Click for ${LABEL[next]}.`} aria-label={`Theme: ${LABEL[theme]}`}>
      <span aria-hidden>{GLYPH[theme]}</span>{LABEL[theme]}
    </button>
  );
}
