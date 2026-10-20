import type {
  ActorAddressInput,
  CreateRuntimeContextOptions,
  ProjectRuntimeContext,
  RuntimeContext,
  RuntimeConnector,
  RuntimeConnectors,
  RuntimeFileSystem,
  RuntimeMcp,
  ProjectMcpClientOptions,
  SpaceRuntimeContext,
} from "./types.js";

/** Canonical, invoker-attested Durable Object address. Scope is part of the identity, so a
 * scratchpad can never share a storage instance with a project or space actor. */
export function actorAddress(input: ActorAddressInput): string {
  if (!input.spaceId) throw new Error("spaceId is required");
  if (input.scope === "USER_PRIVATE") {
    if (!input.userId) throw new Error("userId is required for USER_PRIVATE actors");
    return `actor:personal:${input.spaceId}:${input.userId}`;
  }
  if (input.scope === "PROJECT_BOUND") {
    if (!input.projectId) throw new Error("projectId is required for PROJECT_BOUND actors");
    return `actor:project:${input.spaceId}:${input.projectId}`;
  }
  return `actor:space:${input.spaceId}`;
}

/** Installation scopes are ownership boundaries, not visual or business categories. */
export type InstallationScope = "SPACE_SHARED" | "SPACE_ASSISTANT" | "SPACE_USER" | "PROJECT_BOUND" | "PROJECT_SHARED" | "PROJECT_USER";
export type InstallationStatus = "active" | "removed" | "expired";
export interface ScopedInstallationIdentity {
  tenantId: string;
  spaceId: string;
  extensionId: string;
  scope: InstallationScope;
  projectId?: string | undefined;
  userId?: string | undefined;
  /** Stable host-selected name for multiple independently stateful installs of one release. */
  instanceKey?: string | undefined;
}
export interface ScopedInstallationRecord extends ScopedInstallationIdentity {
  instanceId: string;
  ownerKey: string;
  installedBy: string;
  installedAt: string;
  status: InstallationStatus;
  removedAt?: string;
}
export interface LinkedSpaceGrant { grantId: string; tenantId: string; fromSpaceId: string; toSpaceId: string; userId: string; actions: readonly ("read" | "write")[]; expiresAt?: string; }

const INSTALL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function requireInstallId(label: string, value: string): void {
  if (!INSTALL_ID.test(value)) throw new Error(`invalid_${label}`);
}
function installationOwnerKey(input: ScopedInstallationIdentity): string {
  requireInstallId("tenant_id", input.tenantId); requireInstallId("space_id", input.spaceId); requireInstallId("extension_id", input.extensionId);
  if (input.scope === "SPACE_SHARED") return `space:${input.spaceId}`;
  if (input.scope === "SPACE_ASSISTANT") return `space:${input.spaceId}:assistant`;
  if (input.scope === "SPACE_USER") { if (!input.userId) throw new Error("user_id_required_for_space_user"); requireInstallId("user_id", input.userId); return `space:${input.spaceId}:user:${input.userId}`; }
  if (!input.projectId) throw new Error("project_id_required_for_project_scope");
  requireInstallId("project_id", input.projectId);
  if (input.scope === "PROJECT_BOUND") return `space:${input.spaceId}:project:${input.projectId}:bound`;
  if (input.scope === "PROJECT_USER") { if (!input.userId) throw new Error("user_id_required_for_project_user"); requireInstallId("user_id", input.userId); return `space:${input.spaceId}:project:${input.projectId}:user:${input.userId}`; }
  return `space:${input.spaceId}:project:${input.projectId}`;
}
export function scopedInstallationId(input: ScopedInstallationIdentity): string {
  const owner = installationOwnerKey(input);
  if (input.instanceKey !== undefined && !/^[a-z][a-z0-9_-]{1,31}$/.test(input.instanceKey)) throw new Error("invalid_instance_key");
  return `installation:${input.tenantId}:${input.extensionId}:${owner}${input.instanceKey && input.instanceKey !== "default" ? `:instance:${input.instanceKey}` : ""}`;
}

/** A deterministic local double for the SpaceDO installation lifecycle. It models the same
 * ownership rules used by persistence: shared records outlive projects, user records are
 * removed with the user, and every cleanup operation is safe to repeat. */
export class InstallationLedger {
  private readonly records = new Map<string, ScopedInstallationRecord>();
  install(input: Omit<ScopedInstallationRecord, "instanceId" | "ownerKey" | "status" | "installedAt"> & { installedAt?: string }): ScopedInstallationRecord {
    const instanceId = scopedInstallationId(input);
    const existing = this.records.get(instanceId);
    if (existing?.status === "active") return existing;
    const record: ScopedInstallationRecord = Object.freeze({ ...input, instanceId, ownerKey: installationOwnerKey(input), installedAt: input.installedAt ?? new Date().toISOString(), status: "active" });
    this.records.set(instanceId, record);
    return record;
  }
  uninstall(instanceId: string, now = new Date().toISOString()): ScopedInstallationRecord | undefined {
    const current = this.records.get(instanceId);
    if (!current || current.status !== "active") return current;
    const removed = Object.freeze({ ...current, status: "removed" as const, removedAt: now });
    this.records.set(instanceId, removed);
    return removed;
  }
  removeProject(spaceId: string, projectId: string, now = new Date().toISOString()): number {
    let count = 0;
    for (const record of this.records.values()) if (record.spaceId === spaceId && record.projectId === projectId && record.status === "active") { this.uninstall(record.instanceId, now); count++; }
    return count;
  }
  removeMember(spaceId: string, userId: string, now = new Date().toISOString()): number {
    let count = 0;
    for (const record of this.records.values()) if (record.spaceId === spaceId && record.userId === userId && record.status === "active") { this.uninstall(record.instanceId, now); count++; }
    return count;
  }
  expireSpace(spaceId: string, now = new Date().toISOString()): number {
    let count = 0;
    for (const record of this.records.values()) if (record.spaceId === spaceId && record.status === "active") { const expired = Object.freeze({ ...record, status: "expired" as const, removedAt: now }); this.records.set(record.instanceId, expired); count++; }
    return count;
  }
  list(spaceId?: string): readonly ScopedInstallationRecord[] { return Object.freeze([...this.records.values()].filter((record) => !spaceId || record.spaceId === spaceId)); }
}

export function canUseLinkedSpace(grant: LinkedSpaceGrant, input: { tenantId: string; fromSpaceId: string; toSpaceId: string; userId: string; action: "read" | "write" }, now = Date.now()): boolean {
  return grant.tenantId === input.tenantId && grant.fromSpaceId === input.fromSpaceId && grant.toSpaceId === input.toSpaceId && grant.userId === input.userId && grant.actions.includes(input.action) && (!grant.expiresAt || Date.parse(grant.expiresAt) > now);
}
import { createLaunchpadRuntimeContext } from "./launchpad-runtime.js";
import type { LaunchpadSpace, RuntimeContextAdapters, LaunchpadRuntimeContext } from "./launchpad-runtime.js";

/** Authority stays in the host. Guest code receives only a JSON RPC facade; every call is
 * reauthorized, including after an await, so an expired/revoked grant cannot remain warm. */
export interface CodeInvocationScope {
  tenantId: string; spaceId: string; agentId: string; projectId?: string | undefined; userId?: string | undefined;
  runId?: string | undefined; taskId?: string; installationId?: string | undefined; grantVersion?: string;
}
export interface ScopedCodeRpcOptions {
  scope: Readonly<CodeInvocationScope>;
  capabilities: readonly string[];
  signal: AbortSignal;
  maxCalls?: number; maxPayloadBytes?: number; secrets?: readonly string[];
  authorize(scope: Readonly<CodeInvocationScope>, capability: string): Promise<boolean>;
  dispatch(scope: Readonly<CodeInvocationScope>, capability: string, input: unknown, signal: AbortSignal): Promise<unknown>;
}
export function redactCodeValue(value: unknown, maxBytes = 65_536, secrets: readonly string[] = []): unknown {
  const encoded = JSON.stringify(value ?? null, (key, item: unknown) => {
    if (/(?:secret|password|authorization|api[_-]?key|access[_-]?token|private[_-]?key)/i.test(key)) return "[redacted]";
    if (typeof item === "string") {
      let text = item;
      for (const secret of secrets) if (secret.length >= 8) text = text.split(secret).join("[redacted]");
      return text;
    }
    return item;
  });
  if (new TextEncoder().encode(encoded).byteLength > maxBytes) throw new Error("code_output_limit");
  return JSON.parse(encoded) as unknown;
}
export function createScopedCodeRpc(options: ScopedCodeRpcOptions): (capability: string, input: unknown) => Promise<unknown> {
  if (!options.scope.tenantId || !options.scope.spaceId || !options.scope.agentId) throw new Error("code_scope_required");
  const scope = Object.freeze({ ...options.scope });
  const allowed = new Set(options.capabilities);
  let calls = 0;
  return async (capability, input) => {
    if (options.signal.aborted) throw new Error("code_invocation_closed");
    if (!allowed.has(capability) || !await options.authorize(scope, capability)) throw new Error(`code_capability_denied:${capability}`);
    if (++calls > (options.maxCalls ?? 64)) throw new Error("code_rpc_quota");
    // Clone input rather than letting getters, bindings or mutable host objects cross the boundary.
    const payload = JSON.parse(JSON.stringify(input ?? null)) as unknown;
    if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > (options.maxPayloadBytes ?? 65_536)) throw new Error("code_rpc_payload_limit");
    const result = await options.dispatch(scope, capability, payload, options.signal);
    if (options.signal.aborted || !await options.authorize(scope, capability)) throw new Error("code_invocation_closed");
    return redactCodeValue(result, options.maxPayloadBytes, options.secrets);
  };
}

const CONNECTOR_ALIAS_RE = /^[a-z][a-z0-9_]{1,63}$/;
const MAX_PROJECT_MCP_RESPONSE_BYTES = 1024 * 1024;

async function readProjectMcpResponse(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROJECT_MCP_RESPONSE_BYTES) {
    throw new Error("project_mcp_response_too_large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("project_mcp_invalid_response");
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_PROJECT_MCP_RESPONSE_BYTES) {
        void reader.cancel();
        throw new Error("project_mcp_response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("project_mcp_invalid_response");
  }
}

/** Stateless Streamable HTTP connector for the inter-project MCP mesh. It deliberately creates
 * a fresh JSON-RPC request per operation and keeps no session/socket state. */
export function createProjectMcpClient(options: ProjectMcpClientOptions): RuntimeMcp {
  let nextId = 0;
  const request = async (projectId: string, method: string, params?: Record<string, unknown>) => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) throw new Error("Invalid project id");
    const response = await options.spacesWorker.fetch(new Request(
      `http://spaces-worker/spaces/${encodeURIComponent(options.spaceId)}/projects/${encodeURIComponent(projectId)}/mcp`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "x-naelao-tenant-id": options.tenantId,
          "x-naelao-internal-token": options.internalToken,
          ...(options.userId ? { "x-naelao-user-id": options.userId } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, ...(params ? { params } : {}) }),
      },
    ));
    if (!response.ok) throw new Error(`Project MCP request failed: ${response.status}`);
    const envelope = await readProjectMcpResponse(response) as { result?: unknown; error?: { message?: string } };
    if (envelope.error) throw new Error(envelope.error.message ?? "Project MCP error");
    return envelope.result;
  };
  return Object.freeze({
    call: (projectId: string, tool: string, params: Record<string, unknown> = {}) => request(projectId, "tools/call", { name: tool, arguments: params }),
    listTools: (projectId: string) => request(projectId, "tools/list"),
  });
}

export class MaxDelegationDepthExceededError extends Error {
  constructor() {
    super("Delegation depth is capped at 3");
    this.name = "MaxDelegationDepthExceededError";
  }
}

/** A successful transfer is control flow, not a return: the former holder must stop. */
export class TurnDelegatedError extends Error {
  constructor(readonly result: unknown) {
    super("Turn delegated; caller must yield immediately");
    this.name = "TurnDelegatedError";
  }
}

function connectorSurface(adapter: CreateRuntimeContextOptions["services"]["connectors"]): RuntimeConnectors {
  const get = (aliasName: string, options?: import("./connector-provider.js").ConnectorProviderPreference): RuntimeConnector => {
      if (!CONNECTOR_ALIAS_RE.test(aliasName)) throw new Error("Invalid connector alias");
      const call = (tool: string, params: Record<string, unknown> = {}, scopes: readonly string[] = []) =>
        options?.preferredProvider
          ? adapter.call(aliasName, tool, params, scopes, options)
          : adapter.call(aliasName, tool, params, scopes);
      return new Proxy(Object.freeze({ call }) as RuntimeConnector, {
        get(target, property, receiver) {
          if (property === "then") return undefined;
          if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
          if (typeof property !== "string") return undefined;
          // Calendar providers expose a standardized MCP namespace while retaining the same
          // ergonomic connector surface as other aliases.
          const tool = aliasName === "primary_calendar" && !property.includes(".")
            ? `calendar.${property}` : property;
          return (params: Record<string, unknown> = {}) => call(tool, params);
        },
      });
  };
  return Object.freeze({ get, use: (aliasName: string) => get(aliasName) });
}

const WORKSPACE_ROOT = "/workspace";

/** Normalize an isolate path and reject traversal before it reaches a storage adapter. */
export function workspacePath(path: string): string {
  if (typeof path !== "string" || path.includes("\0")) throw new Error("Invalid workspace path");
  const absolute = path.startsWith("/") ? path : `${WORKSPACE_ROOT}/${path}`;
  const parts: string[] = [];
  for (const part of absolute.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) throw new Error("Path escapes /workspace");
      parts.pop();
    } else parts.push(part);
  }
  const normalized = `/${parts.join("/")}`;
  if (normalized !== WORKSPACE_ROOT && !normalized.startsWith(`${WORKSPACE_ROOT}/`)) {
    throw new Error("Path escapes /workspace");
  }
  return normalized;
}

function scopedFs(fs: RuntimeFileSystem): RuntimeFileSystem {
  return Object.freeze({
    read: async (path: string) => fs.read(workspacePath(path)),
    write: async (path: string, contents: string, options?: { expectedHash?: string }) => options
      ? fs.write(workspacePath(path), contents, options) : fs.write(workspacePath(path), contents),
    edit: async (path: string, oldText: string, newText: string, options?: { expectedHash?: string }) => options
      ? fs.edit(workspacePath(path), oldText, newText, options) : fs.edit(workspacePath(path), oldText, newText),
    diff: async (path: string, contents: string) => fs.diff(workspacePath(path), contents),
    grep: async (pattern: string, options: { path?: string; glob?: string } = {}) =>
      fs.grep(pattern, { ...options, path: workspacePath(options.path ?? WORKSPACE_ROOT) }),
    glob: async (pattern: string) => {
      if (pattern.startsWith("/") || pattern.split("/").includes("..")) workspacePath(pattern);
      return fs.glob(pattern.startsWith("/") ? pattern : `${WORKSPACE_ROOT}/${pattern}`);
    },
  });
}

/**
 * Construct the one SDK surface shared by V8 scripts and durable Workflows.
 * The forbidden top-level property is physically absent rather than throwing at call time.
 */
export function createRuntimeContext(options: CreateRuntimeContextOptions): RuntimeContext;
/** Backward-compatible overload for the pre-convergence Launchpad host API. */
export function createRuntimeContext(space: LaunchpadSpace, projectId: string, adapters: RuntimeContextAdapters): LaunchpadRuntimeContext;
export function createRuntimeContext(options: CreateRuntimeContextOptions | LaunchpadSpace, projectId?: string, adapters?: RuntimeContextAdapters): RuntimeContext | LaunchpadRuntimeContext {
  if (!("scope" in options)) {
    if (!projectId || !adapters) throw new Error("Runtime context requires project adapters");
    return createLaunchpadRuntimeContext(options, projectId, adapters);
  }
  const { services } = options;
  const base = {
    fs: scopedFs(services.fs),
    vault: services.vault,
    browser: services.browser,
    mcp: services.mcp,
    connectors: connectorSurface(services.connectors),
    run: services.run,
    cli: services.cli ?? Object.freeze({
      run: async () => { throw new Error("virtual_cli_unavailable"); },
      register: async () => { throw new Error("virtual_cli_synthesis_unavailable"); },
    }),
  };
  const depth = options.delegationDepth ?? 1;
  if (depth < 1 || depth > 3) throw new MaxDelegationDepthExceededError();
  let delegation: Record<string, unknown> = {};
  if (depth < 3 && services.delegation) {
    const delegationAdapter = services.delegation;
    const delegate = async (request: { targetAgentId: string; task: string; handoverContext?: Record<string, unknown> }): Promise<never> => {
      const result = await delegationAdapter.transfer({
        targetAgentId: request.targetAgentId,
        task: request.task,
        ...(request.handoverContext ? { handoverContext: request.handoverContext } : {}),
        currentDepth: depth as 1 | 2,
        initiatorUserId: options.initiatorUserId ?? "system",
        originatingRoleRank: options.originatingRoleRank ?? 0,
      });
      throw new TurnDelegatedError(result);
    };
    delegation = { delegate, agent: Object.freeze({ delegate }) };
  }
  if (options.scope === "SPACE_WIDE") {
    if (!services.space) throw new Error("SPACE_WIDE runtime requires space services");
    return Object.freeze({ ...base, ...delegation, space: Object.freeze({ id: options.spaceId, ...services.space }) }) as SpaceRuntimeContext;
  }
  if (!services.project) throw new Error("PROJECT_BOUND runtime requires project services");
  return Object.freeze({ ...base, ...delegation, project: Object.freeze({ id: options.projectId, ...services.project }) }) as ProjectRuntimeContext;
}
