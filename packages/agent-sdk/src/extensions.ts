import { assertExtensionId, type ExtensionId, type GadgetScope, type GadgetTier, type RuntimeScope, type ExecutionMode, type PermissionAction } from "./types.js";
import type { CanvasLayout } from "./canvas-runtime.js";

export interface ExtensionGadgetManifest {
  id: string;
  name: string;
  viewportComponent: string;
  scope: GadgetScope;
  gadgetTier: GadgetTier;
  defaultSchemaSql: string;
  migrations?: readonly ExtensionSqlMigration[];
}

export interface ExtensionDaemonManifest {
  id: string;
  name: string;
  workflowScript: string;
  schedule?: string;
  memoryScope: RuntimeScope;
}

export interface ExtensionCommandManifest { name: string; scriptPath: string }
export interface SharedFilesystemGrant { path: string; access: "READ" | "READ_WRITE" }

/** Compatibility contract for extensions installed before modular manifests were introduced. */
export type ExtensionPermission = "storage:read" | "storage:write" | "network" | "mcp:expose" | "alarms";
export interface LegacyExtensionManifest {
  id: string; version: string; permissions: readonly ExtensionPermission[];
  tools: readonly string[]; maxRetries: number; alarmIntervalMs?: number;
}

/** A userspace package. It intentionally has no prompt, kernel, or guard configuration. */
export interface ExtensionManifest {
  id: ExtensionId;
  /** Release identity for a modular package (legacy `version` is reserved for the old contract). */
  releaseVersion?: string;
  type: "extension";
  declaredPermissions: string[];
  /** Gatekeeper capabilities that must be present when this package is installed. */
  capabilityRequirements: string[];
  gadgets: ExtensionGadgetManifest[];
  daemons: ExtensionDaemonManifest[];
  commands: ExtensionCommandManifest[];
  /** Public inbound handlers use a separate channel-only host context. */
  channels?: readonly ChannelContract[];
  /** Versioned composed package; its channel primitives become the runtime channel declarations. */
  bundle?: ExtensionBundleManifest;
  /** Installed sidecars remain userspace declarations, never provider image authority. */
  containers?: readonly ContainerContract[];
  /** Opt-in access to the common Space drive. Paths are directory prefixes below /space/shared/. */
  shared_filesystem?: readonly SharedFilesystemGrant[];
}

/** Stable content pin for the canonical modular extension manifest stored by the host. */
export async function digestExtensionManifest(manifest: ExtensionManifest): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

const ID = /^[a-z][a-z0-9_-]{1,63}$/;
const PERMISSION = /^[a-z][a-z0-9_.:-]{1,127}$/;
const SAFE_PATH = /^(?=.{1,256}$)(?:\.\/)?(?:[a-zA-Z0-9_-][a-zA-Z0-9._-]*\/)*[a-zA-Z0-9_-][a-zA-Z0-9._-]*\.(?:ts|js)$/;
const COMMAND = /^(?:ext:[a-z][a-z0-9_-]{1,59}|[a-z][a-z0-9_-]{1,63})$/;
const FORBIDDEN_KEY = /(?:kernel|systemprompt|coreprompt|promptlayers?|writeguard|gatekeepers?|replloop|reasoningloop|bypass|disableguard|unsandboxed|sandboxdisabled)/i;
const FORBIDDEN_SCRIPT = /(?:NaelaoAgentDO|WriteGuard|Gatekeeper|system\s*prompt|core\s*prompt|reasoning\s*loop|\bmain\b.*(?:push|commit|write)|bypass\s+(?:guard|approval))/i;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`invalid_extension_manifest:${message}`);
}

function validateExtensionMigrations(value: unknown): void {
  assert(Array.isArray(value) && value.length <= 128, "invalid_migrations");
  let previous = 0;
  for (const item of value) {
    assert(item !== null && typeof item === "object" && !Array.isArray(item), "invalid_migration");
    const migration = item as Record<string, unknown>;
    assert(Object.keys(migration).every(key => ["version", "description", "up"].includes(key)), "invalid_migration_field");
    assert(Number.isSafeInteger(migration.version) && Number(migration.version) > previous, "migration_versions_must_increase");
    assert(typeof migration.description === "string" && migration.description.trim().length > 0 && migration.description.length <= 256, "invalid_migration_description");
    assert(typeof migration.up === "string" && migration.up.length > 0 && migration.up.length <= 64_000, "invalid_migration_sql");
    previous = Number(migration.version);
  }
}

function rejectKernelOverrides(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value, depth: 0 }];
  const active = new WeakSet<object>();
  let visited = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (current.exit) { active.delete(current.value as object); continue; }
    if (!current.value || typeof current.value !== "object") continue;
    assert(++visited <= 100_000 && current.depth <= 64, "manifest_complexity_limit");
    assert(!active.has(current.value), "manifest_cycle");
    active.add(current.value);
    pending.push({ value: current.value, depth: current.depth, exit: true });
    for (const [key, nested] of Object.entries(current.value as Record<string, unknown>)) {
      assert(!FORBIDDEN_KEY.test(key), `forbidden_field:${key}`);
      pending.push({ value: nested, depth: current.depth + 1 });
    }
  }
}

export interface ExtensionValidationContext { gatekeeperCapabilities: readonly string[] }
/** Strict parser used at the trust boundary before an extension is persisted. */
export function validateExtensionManifest(value: LegacyExtensionManifest): LegacyExtensionManifest;
export function validateExtensionManifest(value: unknown, context?: ExtensionValidationContext): ExtensionManifest;
export function validateExtensionManifest(value: unknown, context?: ExtensionValidationContext): ExtensionManifest | LegacyExtensionManifest {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), "object_required");
  const raw = value as Record<string, unknown>;
  if ("version" in raw) {
    if (raw.bundle !== undefined) throw new Error("legacy_extension_bundle_requires_modular_manifest");
    return validateLegacyManifest(raw);
  }
  rejectKernelOverrides(raw);
  const allowed = new Set(["id", "releaseVersion", "type", "declaredPermissions", "capabilityRequirements", "gadgets", "daemons", "commands", "channels", "containers", "bundle", "shared_filesystem"]);
  for (const key of Object.keys(raw)) assert(allowed.has(key), `unknown_field:${key}`);
  assert(typeof raw.id === "string", "invalid_id");
  try { assertExtensionId(raw.id); } catch { throw new Error("invalid_extension_manifest:invalid_id"); }
  assert(raw.type === "extension", "invalid_type");
  assert(raw.releaseVersion === undefined || (typeof raw.releaseVersion === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(raw.releaseVersion)), "invalid_release_version");
  assert(Array.isArray(raw.declaredPermissions) && raw.declaredPermissions.length <= 128 && raw.declaredPermissions.every((p) => typeof p === "string" && PERMISSION.test(p)), "invalid_permissions");
  assert(Array.isArray(raw.capabilityRequirements) && raw.capabilityRequirements.length > 0 && raw.capabilityRequirements.length <= 128 && raw.capabilityRequirements.every((p) => typeof p === "string" && PERMISSION.test(p)), "capability_requirements_required");
  if (context) {
    const granted = new Set(context.gatekeeperCapabilities);
    for (const capability of raw.capabilityRequirements as string[]) assert(granted.has(capability), `gatekeeper_capability_denied:${capability}`);
  }
  let canonicalSharedFilesystem: SharedFilesystemGrant[] | undefined;
  if (raw.shared_filesystem !== undefined) {
    assert(Array.isArray(raw.shared_filesystem) && raw.shared_filesystem.length <= 64, "invalid_shared_filesystem");
    const capabilities = new Set(raw.capabilityRequirements as string[]);
    canonicalSharedFilesystem = (raw.shared_filesystem as unknown[]).map((item) => {
      assert(item && typeof item === "object" && !Array.isArray(item), "invalid_shared_filesystem_grant");
      const grant = item as Record<string, unknown>;
      assert(Object.keys(grant).every(key => key === "path" || key === "access"), "invalid_shared_filesystem_grant_field");
      assert(typeof grant.path === "string" && /^\/space\/shared\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)+$/.test(grant.path)
        && grant.path.length <= 256 && !grant.path.includes("..") && !grant.path.includes("\\") && !grant.path.includes("//"), "invalid_shared_filesystem_path");
      assert(grant.access === "READ" || grant.access === "READ_WRITE", "invalid_shared_filesystem_access");
      assert(capabilities.has("space.shared.read"), "shared_filesystem_read_capability_required");
      if (grant.access === "READ_WRITE") assert(capabilities.has("space.shared.write"), "shared_filesystem_write_capability_required");
      return Object.freeze({ path: grant.path, access: grant.access });
    });
  }
  assert(Array.isArray(raw.gadgets) && raw.gadgets.length <= 128
    && Array.isArray(raw.daemons) && raw.daemons.length <= 64
    && Array.isArray(raw.commands) && raw.commands.length <= 256, "arrays_required_or_limit_exceeded");
  let canonicalBundle: ExtensionBundleManifest | undefined;
  let canonicalChannels = raw.channels;
  if (raw.bundle !== undefined) {
    canonicalBundle = parseExtensionBundle(raw.bundle);
    assert(canonicalBundle.id === raw.id, "bundle_extension_id_mismatch");
    const channels = canonicalBundle.primitives.filter((primitive): primitive is ChannelContract => primitive.kind === "channel");
    if (raw.channels !== undefined) {
      assert(Array.isArray(raw.channels), "invalid_channels");
      const legacyChannels = (raw.channels as unknown[]).map(parseExtensionPrimitive);
      assert(JSON.stringify(legacyChannels) === JSON.stringify(channels), "bundle_channel_declaration_mismatch");
    }
    canonicalChannels = channels;
  }
  const scopes = new Set<GadgetScope>(["SPACE_WIDE", "PROJECT_BOUND", "USER_PRIVATE", "PROJECT_SHARED", "PROJECT_USER", "SPACE_SHARED", "SPACE_USER"]);
  const ids = new Set<string>();
  for (const item of raw.gadgets as Record<string, unknown>[]) {
    assert(item && typeof item === "object", "invalid_gadget");
    assert(typeof item.id === "string" && ID.test(item.id) && !ids.has(item.id), "invalid_gadget_id"); ids.add(item.id);
    assert(typeof item.name === "string" && item.name.trim().length > 0, "invalid_gadget_name");
    assert(typeof item.viewportComponent === "string" && SAFE_PATH.test(item.viewportComponent), "invalid_viewport");
    assert(scopes.has(item.scope as GadgetScope), "invalid_gadget_scope");
    assert(item.gadgetTier === 1 || item.gadgetTier === 2 || item.gadgetTier === 3, "invalid_gadget_tier");
    assert(item.gadgetTier !== 1 || ["USER_PRIVATE", "PROJECT_USER", "SPACE_USER"].includes(String(item.scope)), "tier_1_must_be_user_private");
    assert(item.gadgetTier !== 2 || ["PROJECT_BOUND", "PROJECT_SHARED", "PROJECT_USER"].includes(String(item.scope)), "tier_2_scope_invalid");
    assert(item.gadgetTier !== 3 || ["PROJECT_BOUND", "PROJECT_SHARED", "SPACE_WIDE", "SPACE_SHARED"].includes(String(item.scope)), "tier_3_scope_invalid");
    assert(typeof item.defaultSchemaSql === "string" && item.defaultSchemaSql.length <= 64_000, "invalid_schema");
    assert(!FORBIDDEN_SCRIPT.test(item.defaultSchemaSql), "unsafe_schema");
    if (item.migrations !== undefined) validateExtensionMigrations(item.migrations);
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
  if (canonicalChannels !== undefined) {
    assert(Array.isArray(canonicalChannels) && canonicalChannels.length <= 32, "invalid_channels");
    const channelIds = new Set<string>();
    for (const item of canonicalChannels as unknown[]) {
      const channel = parseExtensionPrimitive(item);
      assert(channel.kind === "channel" && !channelIds.has(channel.id), "invalid_channel_kind_or_duplicate");
      channelIds.add(channel.id);
    }
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
  return { ...raw, ...(canonicalSharedFilesystem ? { shared_filesystem: Object.freeze(canonicalSharedFilesystem) } : {}), ...(canonicalBundle ? { bundle: canonicalBundle } : {}), ...(canonicalChannels !== undefined ? { channels: canonicalChannels } : {}) } as unknown as ExtensionManifest;
}

/** Verify a file path is contained in an installed Space-shared directory grant. */
export function isSharedFilesystemPathAllowed(grants: readonly SharedFilesystemGrant[], path: string, access: "read" | "write"): boolean {
  if (typeof path !== "string" || !path || path.length > 1024 || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  const segments = path.split("/");
  if (segments.some(part => !part || part === "." || part === ".." || new TextEncoder().encode(part).byteLength > 255)) return false;
  const absolute = `/space/shared/${path}`;
  return grants.some(grant => (grant.access === "READ_WRITE" || access === "read") && absolute.startsWith(grant.path));
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
export interface PermissionDeclaration { scope: GadgetScope; actions: readonly PermissionAction[]; resource: string; }
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
export interface ExtensionSqlMigration { version: number; description: string; up: string; }
export interface GadgetContract extends ExtensionContractBase { kind: "gadget"; scope: GadgetScope; schemaSql?: string; migrations?: readonly ExtensionSqlMigration[]; }
export interface CanvasContract extends ExtensionContractBase { kind: "canvas"; layout: CanvasLayout | "CanvasMount"; component: string; dynamicPage: boolean; }
/**
 * A channel primitive is invoked for untrusted external events. Its host context is deliberately
 * distinct from member initiated workflows: it contains only the normalized channel event and
 * channel-scoped operations (reply and, when granted, conversation storage). It never implies
 * access to a Space Assistant, planner, project tools, credentials, or workspace files.
 */
export interface ChannelContract extends ExtensionContractBase {
  kind: "channel";
  provider: string;
  /** Optional reference to the host-managed connection requirement used by this handler. */
  connectionId?: string;
  /** Script path inside the installed extension bundle. */
  handlerScript: string;
  /** Versioned least-privilege host surface; other context kinds require a different contract. */
  context: "channel_only";
  inboundEvents: readonly string[];
  outboundEvents: readonly string[];
  /** Named owner-published project collections the channel host may retrieve before dispatch. */
  knowledgeCollections?: readonly string[];
  /** Optional host-managed per-conversation state; disabled unless explicitly enabled. */
  session?: { enabled: true; maxBytes?: number; ttlDays?: number };
}
/** Runtime object exposed as `ctx.channel` to an installed channel handler. The provider's raw
 * webhook, signing secret, owner identity, Space/project APIs, and agent tools are not part of it. */
export interface ChannelOnlyExtensionContext {
  channel: {
    provider: string;
    event: { id: string; type: string; occurredAt: string; payload: Readonly<Record<string, unknown>> };
    conversation: { id: string };
    /** Request one host-bounded, source-grounded response; the handler cannot choose models or tools. */
    answer(input: { question: string }): Promise<{ answerId: string }>;
    reply(message: { text: string }): Promise<{ messageId: string }>;
    /** Available only when the owner-approved channel declaration enables bounded session state. */
    session?: { get(): Promise<unknown>; set(value: unknown): Promise<{ saved: true }> };
  /** Several private records owned by this one external conversation. IDs are extension chosen
   * labels; the host always keys them under the verified project/install/conversation identity. */
  sessions?: { get(sessionId: string): Promise<unknown>; set(sessionId: string, value: unknown): Promise<{ saved: true }> };
  };
}
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
export interface WorkflowContract extends ExtensionContractBase { kind: "workflow"; executionMode: ExecutionMode; entry: string; steps: readonly string[]; toolNames: readonly string[]; }
/** Narrow API available only to an internal project-member Durable Workflow role.
 * `toolNames` declares the workflow capability; the worker role's `gadgetActions` further limits
 * each operation to specific Gadget IDs and schema-declared tables. External channel handlers
 * never receive this context. */
export interface ExtensionWorkflowGadgets {
  list<T = unknown>(stepKey: string, gadgetId: string, table: string, options?: { filter?: Record<string, unknown>; limit?: number }): Promise<T>;
  get<T = unknown>(stepKey: string, gadgetId: string, table: string, id: string | number): Promise<T>;
  insert<T = unknown>(stepKey: string, gadgetId: string, table: string, record: Record<string, unknown>): Promise<T>;
  update<T = unknown>(stepKey: string, gadgetId: string, table: string, id: string | number, record: Record<string, unknown>): Promise<T>;
  delete<T = unknown>(stepKey: string, gadgetId: string, table: string, id: string | number): Promise<T>;
}
export interface ExtensionWorkflowContext<TParams = Record<string, unknown>> {
  readonly params: TParams;
  readonly gadgets: ExtensionWorkflowGadgets;
  readonly tools: { call<T = unknown>(stepKey: string, operation: string, params: Record<string, unknown>): Promise<T> };
}
export type ExtensionPrimitiveManifest = GadgetContract | CanvasContract | ChannelContract | ContainerContract | LinterContract | WorkflowContract;
/**
 * A worker role is an invocation shape, not a trust boundary or a runtime tier.
 * Its authority is still derived from the primitive grants and host-issued install.
 */
export interface ExtensionWorkerRole {
  id: string;
  /** Who may cause this role to run; separate from invocation and compute placement. */
  principal: "project_member" | "space_owner" | "external_channel_subject" | "service";
  invocation: "subagent" | "workflow_step" | "tool";
  execution: "worker" | "container" | "web_container";
  entry: string;
  primitiveIds: readonly string[];
  /** Exact Gadget operations and tables this worker role may invoke from a workflow. */
  gadgetActions?: readonly { gadgetId: string; operations: readonly string[]; tables: readonly string[] }[];
}
/** Host-managed provider dependency. Secrets and transport always remain host-owned. */
export interface ExtensionConnectionRequirement {
  id: string;
  provider: string;
  purpose: string;
  required: boolean;
}
/** Named project knowledge that the owner may publish to a restricted public handler. */
export interface ExtensionKnowledgeRequirement {
  id: string;
  purpose: string;
  access: "member_only" | "owner_published_external";
}
export interface ExtensionBundleManifest {
  schemaVersion: ExtensionSchemaVersion;
  kind: "extension_bundle";
  id: string;
  version: string;
  primitives: readonly ExtensionPrimitiveManifest[];
  workerRoles?: readonly ExtensionWorkerRole[];
  connections?: readonly ExtensionConnectionRequirement[];
  knowledge?: readonly ExtensionKnowledgeRequirement[];
}

const CONTRACT_KINDS = new Set<ExtensionPrimitiveKind>(["gadget", "canvas", "channel", "container", "linter", "workflow"]);
const CONTRACT_ID = /^[a-z][a-z0-9._-]{1,63}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const CONTRACT_PATH = /^(?=.{1,160}$)(?:\.\/)?(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]{0,159}$/;
const CONTRACT_SCOPE = new Set<GadgetScope>(["USER_PRIVATE", "SPACE_WIDE", "PROJECT_BOUND", "PROJECT_SHARED", "PROJECT_USER", "SPACE_SHARED", "SPACE_USER"]);
const CONTRACT_ACTIONS = new Set<PermissionAction>(["read", "write", "execute", "network", "admin"]);
const CONTRACT_BASE_KEYS = new Set(["schemaVersion", "kind", "id", "version", "permissions", "capabilityRequirements", "lifecycle", "budget", "cancellation"]);
function contractAssert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`invalid_extension_contract:${message}`); }
function rejectUnknownContractKeys(raw: Record<string, unknown>, allowed: Set<string>): void { for (const key of Object.keys(raw)) contractAssert(allowed.has(key), `unknown_field:${key}`); }
function validateContractBase(raw: Record<string, unknown>, kind: ExtensionPrimitiveKind): void {
  const specific = kind === "gadget" ? ["scope", "schemaSql", "migrations"] : kind === "canvas" ? ["layout", "component", "dynamicPage"] : kind === "channel" ? ["provider", "connectionId", "handlerScript", "context", "inboundEvents", "outboundEvents", "knowledgeCollections", "session"] : kind === "container" ? ["image", "resources", "exportedBinaries", "mounts", "networkPolicy", "webContainerCompatible"] : kind === "linter" ? ["mode", "entry", "failureMode"] : ["executionMode", "entry", "steps", "toolNames"];
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
  if (kind === "gadget") {
    contractAssert(CONTRACT_SCOPE.has(raw.scope as GadgetScope), "invalid_scope");
    if (raw.schemaSql !== undefined) contractAssert(typeof raw.schemaSql === "string" && raw.schemaSql.length <= 64000, "invalid_schema_sql");
    if (raw.migrations !== undefined) {
      try { validateExtensionMigrations(raw.migrations); } catch (error) { throw new Error(`invalid_extension_contract:${error instanceof Error ? error.message.replace("invalid_extension_manifest:", "") : "invalid_migrations"}`); }
    }
  }
  if (kind === "canvas") {
    contractAssert(["DualPane.Document", "DualPane.DataGrid", "CanvasMount"].includes(String(raw.layout)), "invalid_canvas_layout");
    contractAssert(typeof raw.component === "string" && CONTRACT_PATH.test(raw.component), "invalid_canvas_component");
    contractAssert(typeof raw.dynamicPage === "boolean", "invalid_canvas_dynamic_page");
  }
  if (kind === "channel") {
    // Public channel handlers execute for unauthenticated external senders. Their authority is
    // the channel-only context (normalized event + bounded reply), never extension-wide grants.
    // Reject privilege declarations here so a future dispatcher cannot accidentally interpret
    // a channel primitive as permission to call the member/project capability surface.
    contractAssert((raw.permissions as unknown[]).length === 0, "channel_permissions_forbidden");
    contractAssert((raw.capabilityRequirements as unknown[]).length === 0, "channel_capabilities_forbidden");
    contractAssert(typeof raw.provider === "string" && CONTRACT_ID.test(raw.provider), "invalid_channel_provider");
    contractAssert(raw.connectionId === undefined || (typeof raw.connectionId === "string" && CONTRACT_ID.test(raw.connectionId)), "invalid_channel_connection_reference");
    contractAssert(typeof raw.handlerScript === "string" && /^\.\/[A-Za-z0-9._-]{1,128}\.(?:ts|js)$/.test(raw.handlerScript), "invalid_channel_handler");
    contractAssert(raw.context === "channel_only", "invalid_channel_context");
    for (const [field, events] of [["inboundEvents", raw.inboundEvents], ["outboundEvents", raw.outboundEvents]] as const) {
      contractAssert(Array.isArray(events) && events.length <= 64 && new Set(events).size === events.length, `invalid_${field}`);
      contractAssert((events as unknown[]).every((event) => typeof event === "string" && /^[a-z][a-z0-9_.:-]{0,63}$/.test(event)), `invalid_${field}`);
    }
    contractAssert((raw.inboundEvents as unknown[]).length > 0, "channel_inbound_events_required");
    contractAssert((raw.inboundEvents as unknown[]).includes("message.received"), "channel_message_event_required");
    contractAssert((raw.outboundEvents as unknown[]).includes("message.reply"), "channel_reply_event_required");
    if (raw.knowledgeCollections !== undefined) {
      contractAssert(Array.isArray(raw.knowledgeCollections) && raw.knowledgeCollections.length <= 16
        && new Set(raw.knowledgeCollections).size === raw.knowledgeCollections.length
        && (raw.knowledgeCollections as unknown[]).every(id => typeof id === "string" && /^[a-z][a-z0-9_-]{2,63}$/.test(id)
          && !/^(all|all[_-]|project[_-]?all|space[_-]?all)/i.test(id)), "invalid_channel_knowledge_collections");
    }
    if (raw.session !== undefined) {
      contractAssert(raw.session !== null && typeof raw.session === "object" && !Array.isArray(raw.session), "invalid_channel_session");
      const session = raw.session as Record<string, unknown>;
      rejectUnknownContractKeys(session, new Set(["enabled", "maxBytes", "ttlDays"]));
      contractAssert(session.enabled === true, "channel_session_must_be_opt_in");
      contractAssert(session.maxBytes === undefined || (Number.isInteger(session.maxBytes) && Number(session.maxBytes) >= 1 && Number(session.maxBytes) <= 4_096), "invalid_channel_session_max_bytes");
      contractAssert(session.ttlDays === undefined || (Number.isInteger(session.ttlDays) && Number(session.ttlDays) >= 1 && Number(session.ttlDays) <= 90), "invalid_channel_session_ttl");
    }
    const budget = raw.budget as Record<string, unknown> | undefined;
    contractAssert(budget?.maxCredits === undefined || budget.maxCredits === 0, "channel_credit_budget_unsupported");
    contractAssert(budget?.maxConcurrency === undefined || (Number.isInteger(budget.maxConcurrency) && Number(budget.maxConcurrency) >= 1 && Number(budget.maxConcurrency) <= 4), "channel_concurrency_budget_exceeded");
    contractAssert(budget?.maxDurationSeconds === undefined || (Number.isFinite(budget.maxDurationSeconds) && Number(budget.maxDurationSeconds) >= 1 && Number(budget.maxDurationSeconds) <= 10), "channel_duration_budget_exceeded");
  }
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
  if (kind === "linter") {
    contractAssert(raw.mode === "deterministic" && CONTRACT_PATH.test(String(raw.entry)) && ["warn", "block"].includes(String(raw.failureMode)), "deterministic_linter_required");
  }
  if (kind === "workflow") contractAssert(["interactive", "headless"].includes(String(raw.executionMode)) && typeof raw.entry === "string" && /^\.\/[A-Za-z0-9._-]{1,128}\.(?:ts|js)$/.test(raw.entry)
    && Array.isArray(raw.steps) && (raw.steps as unknown[]).every((item) => typeof item === "string" && CONTRACT_PATH.test(item))
    && Array.isArray(raw.toolNames) && raw.toolNames.length <= 64 && (raw.toolNames as unknown[]).every((item) => typeof item === "string" && CONTRACT_ID.test(item)), "invalid_workflow");
  return Object.freeze(raw as unknown as ExtensionPrimitiveManifest);
}
export function serializeExtensionPrimitive(value: ExtensionPrimitiveManifest): string { return JSON.stringify(parseExtensionPrimitive(value)); }

/** Strict package boundary for composed FDEs. This validates declarations only; installation
 * must still bind each declaration to host-authorized grants and immutable artifact contents. */
export function parseExtensionBundle(value: unknown): ExtensionBundleManifest {
  contractAssert(value !== null && typeof value === "object" && !Array.isArray(value), "bundle_object_required");
  const raw = value as Record<string, unknown>;
  rejectUnknownContractKeys(raw, new Set(["schemaVersion", "kind", "id", "version", "primitives", "workerRoles", "connections", "knowledge"]));
  contractAssert(raw.schemaVersion === "1.0" && raw.kind === "extension_bundle", "invalid_bundle_version_or_kind");
  contractAssert(typeof raw.id === "string" && CONTRACT_ID.test(raw.id), "invalid_bundle_id");
  contractAssert(typeof raw.version === "string" && SEMVER.test(raw.version), "invalid_bundle_version");
  contractAssert(Array.isArray(raw.primitives) && raw.primitives.length <= 128, "invalid_bundle_primitives");
  const primitives = (raw.primitives as unknown[]).map(parseExtensionPrimitive);
  const primitiveIds = new Set<string>();
  for (const primitive of primitives) {
    contractAssert(!primitiveIds.has(primitive.id), "duplicate_bundle_primitive_id");
    primitiveIds.add(primitive.id);
  }
  const workerRoles = raw.workerRoles;
  if (workerRoles !== undefined) {
    contractAssert(Array.isArray(workerRoles) && workerRoles.length <= 64, "invalid_worker_roles");
    const ids = new Set<string>();
    for (const item of workerRoles as unknown[]) {
      contractAssert(item !== null && typeof item === "object" && !Array.isArray(item), "invalid_worker_role");
      const role = item as Record<string, unknown>;
      rejectUnknownContractKeys(role, new Set(["id", "principal", "invocation", "execution", "entry", "primitiveIds", "gadgetActions"]));
      contractAssert(typeof role.id === "string" && CONTRACT_ID.test(role.id) && !ids.has(role.id), "invalid_worker_role_id");
      ids.add(role.id);
      contractAssert(["project_member", "space_owner", "external_channel_subject", "service"].includes(String(role.principal)), "invalid_worker_principal");
      contractAssert(["subagent", "workflow_step", "tool"].includes(String(role.invocation)), "invalid_worker_invocation");
      contractAssert(["worker", "container", "web_container"].includes(String(role.execution)), "invalid_worker_execution");
      contractAssert(typeof role.entry === "string" && CONTRACT_PATH.test(role.entry), "invalid_worker_entry");
      contractAssert(Array.isArray(role.primitiveIds) && new Set(role.primitiveIds).size === role.primitiveIds.length && (role.primitiveIds as unknown[]).every(id => typeof id === "string" && primitiveIds.has(id)), "invalid_worker_primitive_reference");
      if (role.gadgetActions !== undefined) {
        contractAssert(role.principal === "project_member" && ["workflow_step", "tool"].includes(String(role.invocation)), "invalid_worker_gadget_action_principal");
        contractAssert(Array.isArray(role.gadgetActions) && role.gadgetActions.length <= 32, "invalid_worker_gadget_actions");
        const grants = new Set<string>();
        for (const item of role.gadgetActions as unknown[]) {
          contractAssert(item !== null && typeof item === "object" && !Array.isArray(item), "invalid_worker_gadget_action");
          const grant = item as Record<string, unknown>;
          rejectUnknownContractKeys(grant, new Set(["gadgetId", "operations", "tables"]));
          contractAssert(typeof grant.gadgetId === "string" && CONTRACT_ID.test(grant.gadgetId), "invalid_worker_gadget_id");
          contractAssert(Array.isArray(grant.operations) && grant.operations.length > 0 && grant.operations.length <= 5
            && new Set(grant.operations).size === grant.operations.length
            && grant.operations.every(operation => typeof operation === "string" && ["extension.gadget.list", "extension.gadget.get", "extension.gadget.insert", "extension.gadget.update", "extension.gadget.delete"].includes(operation)), "invalid_worker_gadget_operations");
          contractAssert(Array.isArray(grant.tables) && grant.tables.length > 0 && grant.tables.length <= 64
            && new Set(grant.tables).size === grant.tables.length && grant.tables.every(table => typeof table === "string" && /^[a-z][a-z0-9_-]{0,62}$/.test(table)), "invalid_worker_gadget_tables");
          for (const operation of grant.operations as string[]) for (const table of grant.tables as string[]) {
            const key = `${grant.gadgetId}:${operation}:${table}`;
            contractAssert(!grants.has(key), "duplicate_worker_gadget_action"); grants.add(key);
          }
        }
      }
    }
  }
  for (const workflow of primitives.filter((item): item is WorkflowContract => item.kind === "workflow")) {
    contractAssert(Array.isArray(workerRoles) && (workerRoles as ExtensionWorkerRole[]).some(role => role.primitiveIds.includes(workflow.id)
      && role.entry === workflow.entry && ["workflow_step", "tool"].includes(role.invocation)), "workflow_worker_role_binding_required");
    const gadgetOperations = workflow.toolNames.filter(name => name.startsWith("extension.gadget."));
    contractAssert(gadgetOperations.every(name => ["extension.gadget.list", "extension.gadget.get", "extension.gadget.insert", "extension.gadget.update", "extension.gadget.delete"].includes(name))
      && (!gadgetOperations.length || primitives.some(item => item.kind === "gadget")), "invalid_workflow_gadget_capability");
    if (gadgetOperations.length) {
      const roles = (workerRoles as ExtensionWorkerRole[]).filter(role => role.principal === "project_member" && role.entry === workflow.entry && role.primitiveIds.includes(workflow.id)
        && ["workflow_step", "tool"].includes(role.invocation));
      contractAssert(roles.length === 1, "workflow_gadget_role_ambiguous");
      const role = roles[0]!;
      for (const grant of role.gadgetActions ?? []) {
        const gadget = primitives.find((item): item is GadgetContract => item.kind === "gadget" && item.id === grant.gadgetId);
        contractAssert(gadget, "worker_gadget_not_declared");
        contractAssert(grant.operations.every(operation => workflow.toolNames.includes(operation)), "worker_gadget_operation_not_declared");
        const schema = [gadget.schemaSql ?? "", ...(gadget.migrations ?? []).map(migration => migration.up)].join("\n");
        const declaredTables = new Set<string>();
        const createTable = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^\"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z][A-Za-z0-9_]*))/gi;
        for (const match of schema.matchAll(createTable)) declaredTables.add((match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").toLowerCase());
        contractAssert(grant.tables.every(table => declaredTables.has(table.toLowerCase())), "worker_gadget_table_not_declared");
      }
      for (const operation of gadgetOperations) contractAssert((role.gadgetActions ?? []).some(grant => grant.operations.includes(operation)), "workflow_gadget_action_grant_required");
    }
  }
  for (const role of (workerRoles ?? []) as ExtensionWorkerRole[]) for (const grant of role.gadgetActions ?? []) {
    contractAssert(primitives.some(item => item.kind === "workflow" && item.entry === role.entry && role.primitiveIds.includes(item.id)
      && grant.operations.every(operation => item.toolNames.includes(operation))), "worker_gadget_grant_workflow_mismatch");
  }
  for (const [field, max] of [["connections", 32], ["knowledge", 64]] as const) {
    const entries = raw[field];
    if (entries === undefined) continue;
    contractAssert(Array.isArray(entries) && entries.length <= max, `invalid_bundle_${field}`);
    const ids = new Set<string>();
    for (const item of entries as unknown[]) {
      contractAssert(item !== null && typeof item === "object" && !Array.isArray(item), `invalid_bundle_${field}_entry`);
      const entry = item as Record<string, unknown>;
      const allowed = field === "connections" ? new Set(["id", "provider", "purpose", "required"]) : new Set(["id", "purpose", "access"]);
      rejectUnknownContractKeys(entry, allowed);
      contractAssert(typeof entry.id === "string" && CONTRACT_ID.test(entry.id) && !ids.has(entry.id), `invalid_bundle_${field}_id`);
      ids.add(entry.id);
      contractAssert(typeof entry.purpose === "string" && entry.purpose.trim().length > 0 && entry.purpose.length <= 240, `invalid_bundle_${field}_purpose`);
      if (field === "connections") contractAssert(typeof entry.provider === "string" && CONTRACT_ID.test(entry.provider) && typeof entry.required === "boolean", "invalid_connection_requirement");
      else contractAssert(["member_only", "owner_published_external"].includes(String(entry.access)), "invalid_knowledge_access");
    }
  }
  const connections = new Map(((raw.connections ?? []) as Array<{ id: string; provider: string }>).map(connection => [connection.id, connection]));
  for (const primitive of primitives) {
    if (primitive.kind !== "channel" || !primitive.connectionId) continue;
    const connection = connections.get(primitive.connectionId);
    contractAssert(connection?.provider === primitive.provider, "invalid_channel_connection_provider_reference");
  }
  const knowledgeIds = new Set(((raw.knowledge ?? []) as Array<{ id: string }>).map(entry => entry.id));
  for (const primitive of primitives) {
    if (primitive.kind !== "channel" || !primitive.knowledgeCollections) continue;
    contractAssert(primitive.knowledgeCollections.every(id => knowledgeIds.has(id)), "invalid_channel_knowledge_reference");
    const externalKnowledgeIds = new Set(((raw.knowledge ?? []) as Array<{ id: string; access: string }>)
      .filter(entry => entry.access === "owner_published_external").map(entry => entry.id));
    contractAssert(primitive.knowledgeCollections.every(id => externalKnowledgeIds.has(id)), "channel_knowledge_must_be_explicitly_published");
  }
  return Object.freeze({ ...raw, primitives: Object.freeze(primitives) }) as unknown as ExtensionBundleManifest;
}
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
