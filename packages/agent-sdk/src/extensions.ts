export type ExtensionPermission =
  | "storage:read"
  | "storage:write"
  | "network"
  | "mcp:expose"
  | "alarms";
export interface ExtensionManifest {
  id: string;
  version: string;
  permissions: readonly ExtensionPermission[];
  tools: readonly string[];
  maxRetries: number;
  alarmIntervalMs?: number;
}

const PERMISSIONS = new Set<ExtensionPermission>([
  "storage:read",
  "storage:write",
  "network",
  "mcp:expose",
  "alarms",
]);
export function validateExtensionManifest(
  value: ExtensionManifest
): ExtensionManifest {
  if (
    !/^[a-z][a-z0-9-]{1,62}$/.test(value.id) ||
    !/^\d+\.\d+\.\d+$/.test(value.version)
  )
    throw new Error("invalid extension identity");
  if (!value.permissions.every((p) => PERMISSIONS.has(p)))
    throw new Error("unknown extension permission");
  if (
    !Number.isInteger(value.maxRetries) ||
    value.maxRetries < 0 ||
    value.maxRetries > 5
  )
    throw new Error("extension retries must be between 0 and 5");
  if (
    value.alarmIntervalMs !== undefined &&
    (value.alarmIntervalMs < 1_000 || value.alarmIntervalMs > 86_400_000)
  )
    throw new Error("extension alarm interval is out of bounds");
  if (
    value.alarmIntervalMs !== undefined &&
    !value.permissions.includes("alarms")
  )
    throw new Error("alarms permission is required");
  return Object.freeze({
    ...value,
    permissions: Object.freeze([...value.permissions]),
    tools: Object.freeze([...value.tools]),
  });
}

export function requireExtensionPermission(
  manifest: ExtensionManifest,
  permission: ExtensionPermission
): void {
  if (!manifest.permissions.includes(permission))
    throw new Error(`extension permission denied: ${permission}`);
}

export function gadgetStorageKey(
  tenantId: string,
  spaceId: string,
  projectId: string,
  gadgetId: string,
  key: string
): string {
  const fields = [tenantId, spaceId, projectId, gadgetId];
  if (
    fields.some((field) => !/^[A-Za-z0-9_-]{1,128}$/.test(field)) ||
    !key ||
    key.includes("..") ||
    key.startsWith("/")
  )
    throw new Error("invalid gadget storage scope");
  return `gadgets/${tenantId}/${spaceId}/${projectId}/${gadgetId}/${key}`;
}
