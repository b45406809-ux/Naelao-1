import { assertExtensionId, type ExtensionId, type GadgetTier, type RuntimeScope, type KernelLayout, type ExecutionMode, type PermissionAction } from "./types.js";

export interface ExtensionGadgetManifest {
  id: string;
  name: string;
  viewportComponent: string;
  scope: RuntimeScope;
  gadgetTier: GadgetTier;
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
  id: ExtensionId;
  type: "extension";
  declaredPermissions: string[];
  /** Gatekeeper capabilities that must be present when this package is installed. */
  capabilityRequirements: string[];
  gadgets: ExtensionGadgetManifest[];
  daemons: ExtensionDaemonManifest[];
  commands: ExtensionCommandManifest[];
  /** Installed sidecars remain userspace declarations, never provider image authority. */
  containers?: readonly ContainerContract[];
}

const ID = /^[a-z][a-z0-9_-]{1,63}$/;
const PERMISSION = /^[a-z][a-z0-9_.:-]{1,127}$/;
const SAFE_PATH = /^(?:\.\/)?[a-zA-Z0-9_./-]+\.(?:ts|js)$/;
const COMMAND = /^(?:ext:[a-z][a-z0-9_-]{1,59}|[a-z][a-z0-9_-]{1,63})$/;
const FORBIDDEN_KEY = /(?:kernel|systemprompt|coreprompt|promptlayers?|writeguard|gatekeepers?|replloop|reasoningloop|bypass|disableguard|unsandboxed|sandboxdisabled)/i;
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

export interface ExtensionValidationContext { gatekeeperCapabilities: readonly string[] }
/** Strict parser used at the trust boundary before an extension is persisted. */
export function validateExtensionManifest(value: LegacyExtensionManifest): LegacyExtensionManifest;
export function validateExtensionManifest(value: unknown, context?: ExtensionValidationContext): ExtensionManifest;
export function validateExtensionManifest(value: unknown, context?: ExtensionValidationContext): ExtensionManifest | LegacyExtensionManifest {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), "object_required");
  const raw = value as Record<string, unknown>;
  if ("version" in raw) return validateLegacyManifest(raw);
  rejectKernelOverrides(raw);
  const allowed = new Set(["id", "type", "declaredPermissions", "capabilityRequirements", "gadgets", "daemons", "commands", "containers"]);
  for (const key of Object.keys(raw)) assert(allowed.has(key), `unknown_field:${key}`);
  assert(typeof raw.id === "string", "invalid_id");
  try { assertExtensionId(raw.id); } catch { throw new Error("invalid_extension_manifest:invalid_id"); }
  assert(raw.type === "extension", "invalid_type");
  assert(Array.isArray(raw.declaredPermissions) && raw.declaredPermissions.every((p) => typeof p === "string" && PERMISSION.test(p)), "invalid_permissions");
  assert(Array.isArray(raw.capabilityRequirements) && raw.capabilityRequirements.length > 0 && raw.capabilityRequirements.every((p) => typeof p === "string" && PERMISSION.test(p)), "capability_requirements_required");
  if (context) {
    const granted = new Set(context.gatekeeperCapabilities);
    for (const capability of raw.capabilityRequirements as string[]) assert(granted.has(capability), `gatekeeper_capability_denied:${capability}`);
  }
  assert(Array.isArray(raw.gadgets) && Array.isArray(raw.daemons) && Array.isArray(raw.commands), "arrays_required");
  const scopes = new Set<RuntimeScope>(["SPACE_WIDE", "PROJECT_BOUND", "USER_PRIVATE"]);
  const ids = new Set<string>();
  for (const item of raw.gadgets as Record<string, unknown>[]) {
    assert(item && typeof item === "object", "invalid_gadget");
    assert(typeof item.id === "string" && ID.test(item.id) && !ids.has(item.id), "invalid_gadget_id"); ids.add(item.id);
    assert(typeof item.name === "string" && item.name.trim().length > 0, "invalid_gadget_name");
    assert(typeof item.viewportComponent === "string" && SAFE_PATH.test(item.viewportComponent), "invalid_viewport");
    assert(scopes.has(item.scope as RuntimeScope), "invalid_gadget_scope");
    assert(item.gadgetTier === 1 || item.gadgetTier === 2 || item.gadgetTier === 3, "invalid_gadget_tier");
    assert(item.gadgetTier !== 1 || item.scope === "USER_PRIVATE", "tier_1_must_be_user_private");
    assert(item.gadgetTier !== 2 || item.scope === "PROJECT_BOUND", "tier_2_must_be_project_bound");
    assert(item.gadgetTier !== 3 || item.scope === "PROJECT_BOUND" || item.scope === "SPACE_WIDE", "tier_3_scope_invalid");
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
    assert(item && typeof item.name === "string" && COMMAND.test(item.name), "invalid_command_name");
    assert(typeof item.scriptPath === "string" && SAFE_PATH.test(item.scriptPath) && !FORBIDDEN_SCRIPT.test(item.scriptPath), "invalid_command_path");
  }
  if (raw.containers !== undefined) {
    assert(Array.isArray(raw.containers) && raw.containers.length <= 16, "invalid_containers");
    const containerIds = new Set<string>();
    for (const item of raw.containers as unknown[]) {
      const container = parseExtensionPrimitive(item);
      assert(container.kind === "container" && !containerIds.has(container.id), "invalid_container_kind_or_duplicate");
      containerIds.add(container.id);
    }
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

// Versioned, domain-neutral extension contract. The npm package version is intentionally
// independent from this wire schema so old manifests can be adapted safely.
export type ExtensionSchemaVersion = "1.0";
export type ExtensionPrimitiveKind = "gadget" | "canvas" | "channel" | "container" | "linter" | "workflow";
export interface PermissionDeclaration { scope: RuntimeScope; actions: readonly PermissionAction[]; resource: string; }
export interface LifecycleContract { onInstall?: string; onLoad?: string; onUnload?: string; onDelete?: string; }
export interface BudgetContract { maxCredits?: number; maxDurationSeconds?: number; maxConcurrency?: number; }
export interface CancellationContract { owner: "invoker" | "project" | "space_owner" | "admin"; graceSeconds: number; }
export interface ExtensionContractBase {
  schemaVersion: ExtensionSchemaVersion;
  id: string;
  version: string;
  permissions: readonly PermissionDeclaration[];
  capabilityRequirements: readonly string[];
  lifecycle: LifecycleContract;
  budget?: BudgetContract;
  cancellation?: CancellationContract;
}
export interface GadgetContract extends ExtensionContractBase { kind: "gadget"; scope: RuntimeScope; schemaSql?: string; }
export interface CanvasContract extends ExtensionContractBase { kind: "canvas"; layout: KernelLayout; component: string; dynamicPage: boolean; }
export interface ChannelContract extends ExtensionContractBase { kind: "channel"; provider: string; inboundEvents: readonly string[]; outboundEvents: readonly string[]; }
export interface ContainerContract extends ExtensionContractBase {
  kind: "container";
  /** Immutable OCI identity. The host must ALSO approve a deployed binding for this digest. */
  image: string;
  resources: { memoryMb: number; cpuCores: number; timeoutSeconds: number };
  exportedBinaries: readonly string[];
  mounts?: readonly { path: "/workspace" | "/tmp" | "/home/runtime"; writable: boolean }[];
  networkPolicy?: "none" | "approved_proxy";
  webContainerCompatible?: boolean;
}
export interface LinterContract extends ExtensionContractBase { kind: "linter"; mode: "deterministic" | "semantic"; entry: string; failureMode: "warn" | "block"; }
export interface WorkflowContract extends ExtensionContractBase { kind: "workflow"; executionMode: ExecutionMode; steps: readonly string[]; toolNames: readonly string[]; }
export type ExtensionPrimitiveManifest = GadgetContract | CanvasContract | ChannelContract | ContainerContract | LinterContract | WorkflowContract;
export interface ExtensionBundleManifest { schemaVersion: ExtensionSchemaVersion; kind: "extension_bundle"; id: string; version: string; primitives: readonly ExtensionPrimitiveManifest[]; }

const CONTRACT_KINDS = new Set<ExtensionPrimitiveKind>(["gadget", "canvas", "channel", "container", "linter", "workflow"]);
const CONTRACT_ID = /^[a-z][a-z0-9._-]{1,63}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const CONTRACT_PATH = /^[A-Za-z0-9_./-]{1,160}$/;
const CONTRACT_SCOPE = new Set<RuntimeScope>(["USER_PRIVATE", "SPACE_WIDE", "PROJECT_BOUND"]);
const CONTRACT_ACTIONS = new Set<PermissionAction>(["read", "write", "execute", "network", "admin"]);
const CONTRACT_BASE_KEYS = new Set(["schemaVersion", "kind", "id", "version", "permissions", "capabilityRequirements", "lifecycle", "budget", "cancellation"]);
function contractAssert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`invalid_extension_contract:${message}`); }
function rejectUnknownContractKeys(raw: Record<string, unknown>, allowed: Set<string>): void { for (const key of Object.keys(raw)) contractAssert(allowed.has(key), `unknown_field:${key}`); }
function validateContractBase(raw: Record<string, unknown>, kind: ExtensionPrimitiveKind): void {
  const specific = kind === "gadget" ? ["scope", "schemaSql"] : kind === "canvas" ? ["layout", "component", "dynamicPage"] : kind === "channel" ? ["provider", "inboundEvents", "outboundEvents"] : kind === "container" ? ["image", "resources", "exportedBinaries", "mounts", "networkPolicy", "webContainerCompatible"] : kind === "linter" ? ["mode", "entry", "failureMode"] : ["executionMode", "steps", "toolNames"];
  rejectUnknownContractKeys(raw, new Set([...CONTRACT_BASE_KEYS, ...specific]));
  contractAssert(raw.schemaVersion === "1.0", `unsupported_schema_version:${String(raw.schemaVersion)}`);
  contractAssert(raw.kind === kind, `kind_mismatch:${kind}`);
  contractAssert(typeof raw.id === "string" && CONTRACT_ID.test(raw.id), "invalid_id");
  contractAssert(typeof raw.version === "string" && SEMVER.test(raw.version), "invalid_version");
  contractAssert(Array.isArray(raw.permissions), "permissions_required");
  for (const permission of raw.permissions as unknown[]) {
    contractAssert(permission !== null && typeof permission === "object" && !Array.isArray(permission), "invalid_permission");
    const item = permission as Record<string, unknown>;
    rejectUnknownContractKeys(item, new Set(["scope", "actions", "resource"]));
    contractAssert(CONTRACT_SCOPE.has(item.scope as RuntimeScope) && Array.isArray(item.actions) && item.actions.length > 0, "invalid_permission_scope");
    contractAssert((item.actions as unknown[]).every((action) => CONTRACT_ACTIONS.has(action as PermissionAction)), "invalid_permission_action");
    contractAssert(typeof item.resource === "string" && item.resource.length > 0 && item.resource.length <= 160, "invalid_permission_resource");
  }
  contractAssert(Array.isArray(raw.capabilityRequirements) && (raw.capabilityRequirements as unknown[]).every((item) => typeof item === "string" && CONTRACT_ID.test(item)), "invalid_capabilities");
  contractAssert(raw.lifecycle !== null && typeof raw.lifecycle === "object" && !Array.isArray(raw.lifecycle), "lifecycle_required");
  rejectUnknownContractKeys(raw.lifecycle as Record<string, unknown>, new Set(["onInstall", "onLoad", "onUnload", "onDelete"]));
  for (const value of Object.values(raw.lifecycle as Record<string, unknown>)) contractAssert(typeof value === "string" && CONTRACT_PATH.test(value), "invalid_lifecycle_hook");
  if (raw.budget !== undefined) {
    contractAssert(raw.budget !== null && typeof raw.budget === "object" && !Array.isArray(raw.budget), "invalid_budget");
    rejectUnknownContractKeys(raw.budget as Record<string, unknown>, new Set(["maxCredits", "maxDurationSeconds", "maxConcurrency"]));
    for (const value of Object.values(raw.budget as Record<string, unknown>)) contractAssert(typeof value === "number" && Number.isFinite(value) && value >= 0, "invalid_budget_value");
  }
  if (raw.cancellation !== undefined) {
    contractAssert(raw.cancellation !== null && typeof raw.cancellation === "object" && !Array.isArray(raw.cancellation), "invalid_cancellation");
    rejectUnknownContractKeys(raw.cancellation as Record<string, unknown>, new Set(["owner", "graceSeconds"]));
    const cancellation = raw.cancellation as Record<string, unknown>;
    contractAssert(["invoker", "project", "space_owner", "admin"].includes(String(cancellation.owner)) && typeof cancellation.graceSeconds === "number" && cancellation.graceSeconds >= 0, "invalid_cancellation_value");
  }
}

export function parseExtensionPrimitive(value: unknown): ExtensionPrimitiveManifest {
  contractAssert(value !== null && typeof value === "object" && !Array.isArray(value), "object_required");
  const raw = value as Record<string, unknown>;
  contractAssert(raw.schemaVersion === "1.0", `unsupported_schema_version:${String(raw.schemaVersion)}`);
  contractAssert(CONTRACT_KINDS.has(raw.kind as ExtensionPrimitiveKind), `unknown_primitive_kind:${String(raw.kind)}`);
  const kind = raw.kind as ExtensionPrimitiveKind;
  validateContractBase(raw, kind);
  if (kind === "gadget") { contractAssert(CONTRACT_SCOPE.has(raw.scope as RuntimeScope), "invalid_scope"); if (raw.schemaSql !== undefined) contractAssert(typeof raw.schemaSql === "string" && raw.schemaSql.length <= 64000, "invalid_schema_sql"); }
  if (kind === "canvas") contractAssert(["DualPane", "CanvasFirst"].includes(String(raw.layout)) && typeof raw.component === "string" && CONTRACT_PATH.test(raw.component) && typeof raw.dynamicPage === "boolean", "invalid_canvas");
  if (kind === "channel") contractAssert(typeof raw.provider === "string" && CONTRACT_ID.test(raw.provider) && Array.isArray(raw.inboundEvents) && Array.isArray(raw.outboundEvents), "invalid_channel");
  if (kind === "container") {
    contractAssert(typeof raw.image === "string" && raw.image.length <= 300 && /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(raw.image), "immutable_image_digest_required");
    contractAssert(raw.resources !== null && typeof raw.resources === "object" && !Array.isArray(raw.resources), "invalid_resources");
    const resources = raw.resources as Record<string, unknown>;
    rejectUnknownContractKeys(resources, new Set(["memoryMb", "cpuCores", "timeoutSeconds"]));
    for (const [key, limit] of [["memoryMb", 32768], ["cpuCores", 16], ["timeoutSeconds", 60]] as const)
      contractAssert(typeof resources[key] === "number" && Number.isFinite(resources[key]) && Number(resources[key]) > 0 && Number(resources[key]) <= limit, "invalid_resource_value:" + key);
    contractAssert(Array.isArray(raw.exportedBinaries) && raw.exportedBinaries.length > 0 && raw.exportedBinaries.length <= 64 && new Set(raw.exportedBinaries).size === raw.exportedBinaries.length && raw.exportedBinaries.every(item => typeof item === "string" && /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(item)), "invalid_exports");
    contractAssert(raw.networkPolicy === undefined || raw.networkPolicy === "none" || raw.networkPolicy === "approved_proxy", "invalid_network_policy");
    contractAssert(raw.webContainerCompatible === undefined || typeof raw.webContainerCompatible === "boolean", "invalid_browser_compatibility");
    if (raw.mounts !== undefined) {
      contractAssert(Array.isArray(raw.mounts) && raw.mounts.length <= 3, "invalid_mounts");
      const paths = new Set<string>();
      for (const mount of raw.mounts as Record<string, unknown>[]) {
        contractAssert(mount !== null && typeof mount === "object" && !Array.isArray(mount), "invalid_mount");
        rejectUnknownContractKeys(mount, new Set(["path", "writable"]));
        contractAssert(["/workspace", "/tmp", "/home/runtime"].includes(String(mount.path)) && typeof mount.writable === "boolean" && !paths.has(String(mount.path)), "invalid_mount");
        paths.add(String(mount.path));
      }
    }
  }
  if (kind === "linter") contractAssert(["deterministic", "semantic"].includes(String(raw.mode)) && CONTRACT_PATH.test(String(raw.entry)) && ["warn", "block"].includes(String(raw.failureMode)), "invalid_linter");
  if (kind === "workflow") contractAssert(["interactive", "headless"].includes(String(raw.executionMode)) && Array.isArray(raw.steps) && (raw.steps as unknown[]).every((item) => typeof item === "string" && CONTRACT_PATH.test(item)) && Array.isArray(raw.toolNames) && (raw.toolNames as unknown[]).every((item) => typeof item === "string" && CONTRACT_ID.test(item)), "invalid_workflow");
  return Object.freeze(raw as unknown as ExtensionPrimitiveManifest);
}
export function serializeExtensionPrimitive(value: ExtensionPrimitiveManifest): string { return JSON.stringify(parseExtensionPrimitive(value)); }
export function defineGadget(value: GadgetContract): GadgetContract { return parseExtensionPrimitive(value) as GadgetContract; }
export function defineCanvas(value: CanvasContract): CanvasContract { return parseExtensionPrimitive(value) as CanvasContract; }
export function defineChannelAdapter(value: ChannelContract): ChannelContract { return parseExtensionPrimitive(value) as ChannelContract; }
export function defineContainer(value: ContainerContract): ContainerContract { return parseExtensionPrimitive(value) as ContainerContract; }
export function defineLinter(value: LinterContract): LinterContract { return parseExtensionPrimitive(value) as LinterContract; }
export function defineWorkflow(value: WorkflowContract): WorkflowContract { return parseExtensionPrimitive(value) as WorkflowContract; }

export function migrateLegacyExtensionManifest(value: unknown): ExtensionBundleManifest {
  const legacy = validateExtensionManifest(value as LegacyExtensionManifest) as LegacyExtensionManifest;
  const actions: PermissionAction[] = legacy.permissions.includes("storage:write") ? ["read", "write"] : ["read"];
  const migrated: GadgetContract = { schemaVersion: "1.0", kind: "gadget", id: `ext_${legacy.id}`, version: legacy.version, scope: "PROJECT_BOUND", permissions: [{ scope: "PROJECT_BOUND", actions, resource: "legacy" }], capabilityRequirements: ["legacy.adapter"], lifecycle: {}, schemaSql: "CREATE TABLE legacy_extension_state (key TEXT PRIMARY KEY, value TEXT)" };
  return Object.freeze({ schemaVersion: "1.0", kind: "extension_bundle", id: `bundle_${legacy.id}`, version: legacy.version, primitives: Object.freeze([defineGadget(migrated)]) });
}
