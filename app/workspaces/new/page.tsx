import { requireCtx } from "@/lib/session";
import { createWorkspaceAction } from "@/app/actions";

export default async function NewWorkspacePage() {
  await requireCtx();
  return (
    <div style={{ maxWidth: 480 }}>
      <div className="eyebrow">New workspace</div>
      <h1>A separate book for a household or a team</h1>
      <p className="muted" style={{ margin: "8px 0 18px" }}>Each workspace has its own agents, mandates, approvers and ledger. You'll be its owner and can invite members next.</p>
      <form action={createWorkspaceAction} className="card form">
        <div className="field"><label htmlFor="name">Workspace name</label><input id="name" name="name" required placeholder="e.g. Home, or Acme Ops" /></div>
        <div className="actions"><button className="btn accent" type="submit">Create workspace</button></div>
      </form>
    </div>
  );
}
