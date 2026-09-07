import { requireCtx } from "@/lib/session";
import { statsRows } from "@/lib/stats";
import { StatsClient } from "./client";

export default async function StatsPage() {
  const ctx = await requireCtx();
  const { rows, truncated, mandates } = await statsRows(ctx.workspaceId);
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Spending statistics · {ctx.workspaceName}</div>
          <h1>Where the money went, and where it is going</h1>
          <p className="muted">Every decision in the last year, sliced by day, week, month or year. Approved amounts are what counts as spend; declines and escalations show where the terms bit.{truncated && " Showing the most recent 5,000 decisions."}</p>
        </div>
      </div>
      <StatsClient rows={rows} mandates={mandates} />
    </>
  );
}
