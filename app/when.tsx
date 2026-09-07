"use client";

import { useEffect, useState } from "react";

// Timestamps in the viewer's own timezone and locale. The server renders the
// UTC form; the browser re-formats after hydration, so nothing is hardcoded
// to one country.
export function When({ d }: { d: Date | number | string | null }) {
  const [local, setLocal] = useState<string | null>(null);
  const iso = d ? new Date(d).toISOString() : null;
  useEffect(() => {
    if (!iso) return;
    const date = new Date(iso);
    const sameYear = date.getFullYear() === new Date().getFullYear();
    setLocal(date.toLocaleString(undefined, { day: "2-digit", month: "short", ...(sameYear ? {} : { year: "numeric" }), hour: "2-digit", minute: "2-digit", hour12: false }));
  }, [iso]);
  if (!iso) return <span className="faint">—</span>;
  return <span className="num" title={iso} suppressHydrationWarning>{local ?? iso.slice(0, 16).replace("T", " ") + " UTC"}</span>;
}
