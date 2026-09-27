import type {
  CreateRuntimeContextOptions,
  ProjectRuntimeContext,
  RuntimeContext,
  RuntimeConnector,
  RuntimeConnectors,
  RuntimeFileSystem,
  SpaceRuntimeContext,
} from "./types.js";
import { createLaunchpadRuntimeContext } from "./launchpad-runtime.js";
import type { LaunchpadSpace, RuntimeContextAdapters, LaunchpadRuntimeContext } from "./launchpad-runtime.js";

const CONNECTOR_ALIAS_RE = /^[a-z][a-z0-9_]{1,63}$/;

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
  return Object.freeze({
    use(aliasName: string): RuntimeConnector {
      if (!CONNECTOR_ALIAS_RE.test(aliasName)) throw new Error("Invalid connector alias");
      const call = (tool: string, params: Record<string, unknown> = {}, scopes: readonly string[] = []) =>
        adapter.call(aliasName, tool, params, scopes);
      return new Proxy(Object.freeze({ call }) as RuntimeConnector, {
        get(target, property, receiver) {
          if (property === "then") return undefined;
          if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
          if (typeof property !== "string") return undefined;
          return (params: Record<string, unknown> = {}) => call(property, params);
        },
      });
    },
  });
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
    write: async (path: string, contents: string) => fs.write(workspacePath(path), contents),
    edit: async (path: string, oldText: string, newText: string) => fs.edit(workspacePath(path), oldText, newText),
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
