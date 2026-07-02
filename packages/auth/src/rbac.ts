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
};

export function hasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

export function assertPermission(role: UserRole, permission: Permission): void {
  if (!hasPermission(role, permission)) {
    throw new Error(`Role '${role}' lacks permission '${permission}'`);
  }
}
