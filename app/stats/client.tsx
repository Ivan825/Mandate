"use client";

import { useEffect, useState } from "react";
import { StatsView } from "./view";
import type { StatRow } from "@/lib/stats";

// The charts bucket by the viewer's local time, so they are rendered only
// in the browser: the server (UTC) would otherwise paint a different picture
// for a second and React would complain about the mismatch.
export function StatsClient(props: { rows: StatRow[]; mandates: Parameters<typeof StatsView>[0]["mandates"] }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div className="card empty">Preparing your charts…</div>;
  return <StatsView {...props} />;
}
