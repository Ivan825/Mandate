import { createHash } from "node:crypto";

// The public name of a workspace: a hash of its id, so anchors and receipts
// can be compared across workspaces without naming the account behind them.
export function workspaceLabel(workspaceId: string): string {
  return createHash("sha256").update("mandate-ws:" + workspaceId).digest("hex");
}
