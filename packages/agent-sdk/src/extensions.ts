import type { RuntimeScope } from "./types.js";

export interface ExtensionGadgetManifest {
  id: string;
  name: string;
  viewportComponent: string;
  scope: RuntimeScope;
  defaultSchemaSql: string;
}

export interface ExtensionDaemonManifest {
  id: string;
  name: string;
  workflowScript: string;
  schedule?: string;
  memoryScope: RuntimeScope;
}

export interface ExtensionCommandManifest { name: string; scriptPath: string }

/** Compatibility contract for extensions installed before modular manifests were introduced. */
export type ExtensionPermission = "storage:read" | "storage:write" | "network" | "mcp:expose" | "alarms";
export interface LegacyExtensionManifest {
  id: string; version: string; permissions: readonly ExtensionPermission[];
  tools: readonly string[]; maxRetries: number; alarmIntervalMs?: number;
}

/** A userspace package. It intentionally has no prompt, kernel, or guard configuration. */
export interface ExtensionManifest {
  id: `ext_${string}`;
  type: "extension";
  declaredPermissions: string[];
  gadgets: ExtensionGadgetManifest[];
  daemons: ExtensionDaemonManifest[];
  commands: ExtensionCommandManifest[];
}

const ID = /^[a-z][a-z0-9_-]{1,63}$/;
const EXTENSION_ID = /^ext_[a-z][a-z0-9_-]{1,59}$/;
const PERMISSION = /^[a-z][a-z0-9_.:-]{1,127}$/;
const SAFE_PATH = /^(?:\.\/)?[a-zA-Z0-9_./-]+\.(?:ts|js)$/;
const FORBIDDEN_KEY = /(?:kernel|systemprompt|coreprompt|promptlayers?|writeguard|gatekeepers?|replloop|reasoningloop|bypass|disableguard)/i;
const FORBIDDEN_SCRIPT = /(?:NaelaoAgentDO|WriteGuard|Gatekeeper|system\s*prompt|core\s*prompt|reasoning\s*loop|\bmain\b.*(?:push|commit|write)|bypass\s+(?:guard|approval))/i;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`invalid_extension_manifest:${message}`);
}

function rejectKernelOverrides(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { for (const item of value) rejectKernelOverrides(item); return; }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    assert(!FORBIDDEN_KEY.test(key), `forbidden_field:${key}`);
    rejectKernelOverrides(nested);
  }
}

/** Strict parser used at the trust boundary before an extension is persisted. */
export function validateExtensionManifest(value: LegacyExtensionManifest): LegacyExtensionManifest;
export function validateExtensionManifest(value: unknown): ExtensionManifest;
export function validateExtensionManifest(value: unknown): ExtensionManifest | LegacyExtensionManifest {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), "object_required");
  const raw = value as Record<string, unknown>;
  if ("version" in raw) return validateLegacyManifest(raw);
  rejectKernelOverrides(raw);
  const allowed = new Set(["id", "type", "declaredPermissions", "gadgets", "daemons", "commands"]);
  for (const key of Object.keys(raw)) assert(allowed.has(key), `unknown_field:${key}`);
  assert(typeof raw.id === "string" && EXTENSION_ID.test(raw.id), "invalid_id");
  assert(raw.type === "extension", "invalid_type");
  assert(Array.isArray(raw.declaredPermissions) && raw.declaredPermissions.every((p) => typeof p === "string" && PERMISSION.test(p)), "invalid_permissions");
  assert(Array.isArray(raw.gadgets) && Array.isArray(raw.daemons) && Array.isArray(raw.commands), "arrays_required");
  const scopes = new Set<RuntimeScope>(["SPACE_WIDE", "PROJECT_BOUND", "USER_PRIVATE"]);
  const ids = new Set<string>();
  for (const item of raw.gadgets as Record<string, unknown>[]) {
    assert(item && typeof item === "object", "invalid_gadget");
    assert(typeof item.id === "string" && ID.test(item.id) && !ids.has(item.id), "invalid_gadget_id"); ids.add(item.id);
    assert(typeof item.name === "string" && item.name.trim().length > 0, "invalid_gadget_name");
    assert(typeof item.viewportComponent === "string" && SAFE_PATH.test(item.viewportComponent), "invalid_viewport");
    assert(scopes.has(item.scope as RuntimeScope), "invalid_gadget_scope");
    assert(typeof item.defaultSchemaSql === "string" && item.defaultSchemaSql.length <= 64_000, "invalid_schema");
    assert(!FORBIDDEN_SCRIPT.test(item.defaultSchemaSql), "unsafe_schema");
  }
  for (const item of raw.daemons as Record<string, unknown>[]) {
    assert(item && typeof item === "object", "invalid_daemon");
    assert(typeof item.id === "string" && ID.test(item.id) && !ids.has(item.id), "invalid_daemon_id"); ids.add(item.id);
    assert(typeof item.name === "string" && item.name.trim().length > 0, "invalid_daemon_name");
    assert(typeof item.workflowScript === "string" && SAFE_PATH.test(item.workflowScript) && !FORBIDDEN_SCRIPT.test(item.workflowScript), "invalid_workflow_script");
    assert(scopes.has(item.memoryScope as RuntimeScope), "invalid_memory_scope");
    assert(item.schedule === undefined || (typeof item.schedule === "string" && item.schedule.length <= 128), "invalid_schedule");
  }
  for (const item of raw.commands as Record<string, unknown>[]) {
    assert(item && typeof item.name === "string" && ID.test(item.name), "invalid_command_name");
    assert(typeof item.scriptPath === "string" && SAFE_PATH.test(item.scriptPath) && !FORBIDDEN_SCRIPT.test(item.scriptPath), "invalid_command_path");
  }
  return raw as unknown as ExtensionManifest;
}

const LEGACY_PERMISSIONS = new Set<ExtensionPermission>(["storage:read", "storage:write", "network", "mcp:expose", "alarms"]);
function validateLegacyManifest(raw: Record<string, unknown>): LegacyExtensionManifest {
  if (!(typeof raw.id === "string" && /^[a-z][a-z0-9-]{1,62}$/.test(raw.id) && typeof raw.version === "string" && /^\d+\.\d+\.\d+$/.test(raw.version))) throw new Error("invalid extension identity");
  if (!(Array.isArray(raw.permissions) && raw.permissions.every((p) => LEGACY_PERMISSIONS.has(p as ExtensionPermission)))) throw new Error("unknown extension permission");
  assert(Array.isArray(raw.tools) && raw.tools.every((tool) => typeof tool === "string"), "invalid_legacy_tools");
  if (!(Number.isInteger(raw.maxRetries) && Number(raw.maxRetries) >= 0 && Number(raw.maxRetries) <= 5)) throw new Error("extension retries must be between 0 and 5");
  if (!(raw.alarmIntervalMs === undefined || (typeof raw.alarmIntervalMs === "number" && raw.alarmIntervalMs >= 1_000 && raw.alarmIntervalMs <= 86_400_000))) throw new Error("extension alarm interval is out of bounds");
  if (!(raw.alarmIntervalMs === undefined || (raw.permissions as unknown[]).includes("alarms"))) throw new Error("alarms permission is required");
  return Object.freeze({ ...(raw as unknown as LegacyExtensionManifest), permissions: Object.freeze([...(raw.permissions as ExtensionPermission[])]), tools: Object.freeze([...(raw.tools as string[])]) });
}

export function requireExtensionPermission(manifest: LegacyExtensionManifest, permission: ExtensionPermission): void {
  if (!manifest.permissions.includes(permission)) throw new Error(`extension permission denied: ${permission}`);
}

/** Legacy workspace-object key helper retained for already-installed Phase 1 extensions. */
export function gadgetStorageKey(tenantId: string, spaceId: string, projectId: string, gadgetId: string, key: string): string {
  const fields = [tenantId, spaceId, projectId, gadgetId];
  if (fields.some((field) => !/^[A-Za-z0-9_-]{1,128}$/.test(field)) || !key || key.includes("..") || key.startsWith("/")) throw new Error("invalid gadget storage scope");
  return `gadgets/${tenantId}/${spaceId}/${projectId}/${gadgetId}/${key}`;
}
