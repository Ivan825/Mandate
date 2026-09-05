import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements, adminAc, ownerAc } from "better-auth/plugins/organization/access";

// What a person may do inside a workspace. Roles are deliberately few and
// map onto how a household or a team actually delegates money:
//   owner    — everything, including deleting the workspace
//   admin    — everything except deleting the workspace or changing the owner
//   approver — can decide requests in the inbox and see everything; cannot
//              issue or revoke mandates, add agents, or manage members
//   viewer   — read-only

export const statement = {
  ...defaultStatements,
  agent: ["create"],
  mandate: ["issue", "revoke", "try"],
  approval: ["decide"],
  ledger: ["export"],
  workspace: ["settings"],
  proxy: ["manage"],
} as const;

export const ac = createAccessControl(statement);

const full = { agent: ["create"], mandate: ["issue", "revoke", "try"], approval: ["decide"], ledger: ["export"], workspace: ["settings"], proxy: ["manage"] } as const;

export const roles = {
  owner: ac.newRole({ ...ownerAc.statements, ...full }),
  admin: ac.newRole({ ...adminAc.statements, ...full }),
  approver: ac.newRole({ approval: ["decide"], ledger: ["export"] }),
  viewer: ac.newRole({}),
};

export type Role = keyof typeof roles;
export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner — full control",
  admin: "Admin — everything but deleting the workspace",
  approver: "Approver — decides requests, sees everything",
  viewer: "Viewer — read only",
};
export const ASSIGNABLE_ROLES: Role[] = ["admin", "approver", "viewer"];
