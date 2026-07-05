import type { UserRole } from "@naelao/types";

type Permission =
  | "spaces:read"
  | "spaces:write"
  | "spaces:delete"
  | "kb:read"
  | "kb:write"
  | "kb:delete"
  | "analytics:read"
  | "billing:read"
  | "billing:write"
  | "members:read"
  | "members:write"
  | "api_keys:read"
  | "api_keys:write"
  | "admin:all";

const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  owner: [
    "spaces:read", "spaces:write", "spaces:delete",
    "kb:read", "kb:write", "kb:delete",
    "analytics:read", "billing:read", "billing:write",
    "members:read", "members:write",
    "api_keys:read", "api_keys:write",
    "admin:all",
  ],
  admin: [
    "spaces:read", "spaces:write", "spaces:delete",
    "kb:read", "kb:write", "kb:delete",
    "analytics:read", "billing:read",
    "members:read", "members:write",
    "api_keys:read", "api_keys:write",
  ],
  editor: [
    "spaces:read", "spaces:write",
    "kb:read", "kb:write",
    "analytics:read",
    "api_keys:read",
  ],
  viewer: ["spaces:read", "kb:read", "analytics:read"],
  // Three-Tier Platform Model: a product end user (ProductUserDO-authenticated, no platform
  // tenant membership) is a structurally different population from Team collaborators — none of
  // these builder-dashboard permissions apply. Fails closed (empty), not inherited from viewer;
  // end-user access to their own product surface is governed by the product-scoped session/
  // route allowlist in workers/router/src/index.ts, not this RBAC table.
  product_end_user: [],
  // §A1.17 Phase O: an agent's nak_... key is gated by its own assistant_policy/agent_policy_
  // overrides row (workers/spaces/src/do/SpaceDO.ts), not this RBAC table — fails closed here too
  // (no builder-dashboard permission implied by holding an agent key).
  agent: [],
};

export function hasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

export function assertPermission(role: UserRole, permission: Permission): void {
  if (!hasPermission(role, permission)) {
    throw new Error(`Role '${role}' lacks permission '${permission}'`);
  }
}
