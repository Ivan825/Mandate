import { requireCtx } from "@/lib/session";
import { createAgentAction } from "@/app/actions";

export default async function NewAgentPage() {
  await requireCtx();
  return (
    <div style={{ maxWidth: 560 }}>
      <div className="eyebrow">New agent</div>
      <h1>Who is this authority for?</h1>
      <p className="muted" style={{ margin: "8px 0 20px" }}>An agent is anything that acts for you: a shopping agent, a coding agent buying API credits, a research assistant paying for data. Name it the way you'd recognise it in a statement.</p>
      <form action={createAgentAction} className="form card">
        <div className="field">
          <label htmlFor="name">Agent name</label>
          <input id="name" name="name" required placeholder="e.g. Claude Code (work laptop)" />
        </div>
        <div className="field">
          <label htmlFor="description">What it does</label>
          <textarea id="description" name="description" placeholder="Buys API credits and developer tools for the side project." />
        </div>
        <div className="actions"><button className="btn accent" type="submit">Create and issue a mandate</button></div>
      </form>
    </div>
  );
}
