"use client";

export function WorkspaceSwitcher({ current, orgs, action }: { current: string; orgs: { id: string; name: string }[]; action: (form: FormData) => void | Promise<void> }) {
  if (orgs.length <= 1) return null;
  return (
    <form action={action}>
      <select name="organizationId" defaultValue={current} onChange={(e) => e.currentTarget.form?.requestSubmit()} style={{ width: "auto", padding: "5px 8px", fontSize: 13 }} aria-label="Workspace">
        {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </form>
  );
}
