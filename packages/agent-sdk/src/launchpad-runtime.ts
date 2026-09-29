/**
 * Launchpad workspace runtime (AVOS build plan features 1-20).
 *
 * This module contains policy and orchestration, while Cloudflare-specific implementations
 * (Durable Object SQL, Artifacts, Browser Rendering, Workflows and Containers) are adapters.
 * Keeping those seams explicit makes the rules testable and prevents scripts from selecting
 * infrastructure or receiving credentials.
 */

export const LAUNCHPAD_SPACE_TYPE = "launchpad" as const;
export const WORKSPACE_ROOT = "/workspace" as const;
export const AVOS_ROOT = "/.avos" as const;
export const CONTAINER_IDLE_TIMEOUT_MS = 60_000;

export type SpaceDepth = 0 | 1;
export type SpaceRole = "owner" | "admin" | "member";
export type ProjectVisibility = "public" | "private";

export interface LaunchpadSpace {
  id: string;
  type: typeof LAUNCHPAD_SPACE_TYPE;
  depth: SpaceDepth;
  parentId: string | null;
}

/** Enforces the finalized two-level hierarchy and the single-SpaceType decision. */
export function defineLaunchpadSpace(
  input: Omit<LaunchpadSpace, "type">
): LaunchpadSpace {
  // Keep the runtime check even though SpaceDepth is a union: JSON and database values cross
  // this boundary without TypeScript's protection.
  if (input.depth !== 0 && input.depth !== 1)
    throw new Error(
      "Launchpad spaces are limited to a root and one department level"
    );
  if (input.depth === 0 && input.parentId !== null)
    throw new Error("Root spaces cannot have a parent");
  if (input.depth === 1 && !input.parentId)
    throw new Error("Department spaces require a parent");
  return { ...input, type: LAUNCHPAD_SPACE_TYPE };
}

export interface SpaceAccessSubject {
  userId: string;
  /** Membership in the requested space. */
  role?: SpaceRole;
  /** Role in the direct parent, when the requested space is a department. */
  parentRole?: SpaceRole;
}

export type SpaceAction = "read" | "manage";

/** Parent owners/admins oversee children; membership never flows upward or sideways. */
export function canAccessSpace(
  space: LaunchpadSpace,
  subject: SpaceAccessSubject,
  action: SpaceAction
): boolean {
  if (subject.role === "owner" || subject.role === "admin") return true;
  if (action === "read" && subject.role === "member") return true;
  return (
    space.depth === 1 &&
    (subject.parentRole === "owner" || subject.parentRole === "admin")
  );
}

export interface ProjectAccess {
  visibility: ProjectVisibility;
  isSpaceMember: boolean;
  projectRole?: "owner" | "editor" | "viewer";
  isSpaceAdmin?: boolean;
}

/** A denied private project is intentionally indistinguishable from a missing project. */
export function authorizeProject(
  access: ProjectAccess
): { allowed: true } | { allowed: false; status: 404 } {
  const allowed =
    access.isSpaceMember &&
    (access.visibility === "public" ||
      Boolean(access.projectRole) ||
      access.isSpaceAdmin === true);
  return allowed ? { allowed: true } : { allowed: false, status: 404 };
}

export interface ProjectAutomation {
  id: string;
  projectId: string;
  kind: "workflow" | "cron";
  entrypoint: string;
}

/** Automations cannot exist at the space root. */
export function defineProjectAutomation(
  input: ProjectAutomation
): ProjectAutomation {
  if (!input.projectId.trim())
    throw new Error("Automation must be anchored to a project");
  if (!input.entrypoint.trim())
    throw new Error("Automation entrypoint is required");
  return { ...input };
}

export function requireManageableAutomationProject(params: {
  spaceId: string;
  projectId: string;
  projectSpaceId: string;
  projectStatus: string;
  userRole?: string | null;
  isSpaceAdmin?: boolean;
}): { allowed: true } {
  if (!params.projectId || !params.projectId.trim()) {
    throw new Error("Automation must be anchored to a project");
  }
  if (
    params.spaceId !== params.projectSpaceId ||
    params.projectStatus !== "active"
  ) {
    throw new Error("project_not_found");
  }
  const allowed =
    params.isSpaceAdmin === true ||
    params.userRole === "owner" ||
    params.userRole === "editor";
  if (!allowed) {
    throw new Error("insufficient_project_permission");
  }
  return { allowed: true };
}
// ── Artifact repository and filesystem ──────────────────────────────────────

export interface CommitMetadata {
  agentRole: string;
  userGoal: string;
  taskId: string;
  rationale: string;
}

export function validateCommitMetadata(
  metadata: CommitMetadata
): CommitMetadata {
  for (const [field, value] of Object.entries(metadata)) {
    if (typeof value !== "string" || !value.trim())
      throw new Error(`commit_metadata_missing:${field}`);
    if (value.length > 2_048)
      throw new Error(`commit_metadata_too_large:${field}`);
  }
  return Object.freeze({ ...metadata });
}

export interface ArtifactCommit {
  oid: string;
  parentOid?: string;
  message: string;
  metadata: CommitMetadata;
  createdAt: number;
}

/** Adapter implemented by the Artifacts Git Zig/WASM Durable Object. */
export interface ArtifactRepository {
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, value: Uint8Array): Promise<void>;
  commit(message: string, metadata: CommitMetadata): Promise<ArtifactCommit>;
  branch(name: string, fromOid?: string): Promise<void>;
  checkout(ref: string): Promise<void>;
  head(): Promise<string>;
  diff(fromOid: string, toOid?: string): Promise<string>;
}

export function normalizeWorkspacePath(path: string): string {
  if (
    !path ||
    path.includes("\\") ||
    [...path].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127;
    })
  )
    throw new Error("Workspace path contains invalid characters");
  // Adapters must receive one canonical representation. Reject encoded separators and dot
  // segments rather than letting an HTTP/FUSE adapter decode them after this boundary check.
  // Double decoding is intentionally covered as well (for example %252e%252e%252f).
  let decoded = path;
  for (let pass = 0; pass < 2; pass += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      throw new Error("Workspace path contains invalid encoding");
    }
    if (next === decoded) break;
    decoded = next;
  }
  if (decoded !== path && /(?:^|[\\/])\.\.?(?:[\\/]|$)|[\\/]/.test(decoded))
    throw new Error("Encoded workspace path components are not allowed");
  const absolute = path.startsWith("/") ? path : `${WORKSPACE_ROOT}/${path}`;
  const requestedRoot =
    absolute === WORKSPACE_ROOT || absolute.startsWith(`${WORKSPACE_ROOT}/`)
      ? WORKSPACE_ROOT
      : absolute === AVOS_ROOT || absolute.startsWith(`${AVOS_ROOT}/`)
        ? AVOS_ROOT
        : null;
  if (!requestedRoot)
    throw new Error("Path must be inside /workspace or /.avos");
  const parts: string[] = [];
  for (const part of absolute.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  const normalized = `/${parts.join("/")}`;
  // Reject traversal that starts in one namespace and normalizes into the other. Merely
  // checking the final path made `/workspace/../.avos/...` a namespace-confusion bypass.
  if (
    normalized !== requestedRoot &&
    !normalized.startsWith(`${requestedRoot}/`)
  )
    throw new Error("Workspace and AVOS namespaces cannot be mixed");
  return normalized;
}

export function isGitTracked(path: string): boolean {
  const normalized = normalizeWorkspacePath(path);
  return (
    normalized === WORKSPACE_ROOT || normalized.startsWith(`${WORKSPACE_ROOT}/`)
  );
}

export interface ArtifactFS {
  /** Metadata only; content is fetched by read(), providing lazy hydration. */
  list(
    path: string
  ): Promise<Array<{ path: string; size: number; oid: string }>>;
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, value: Uint8Array): Promise<void>;
}

export interface ShellState {
  cwd: string;
  env: Record<string, string>;
  gitHead: string;
  revision: number;
}

/** Optimistic four-dimensional state prevents an isolate/container split-brain. */
export class WorkspaceStateCoordinator {
  private state: ShellState;
  constructor(initial: ShellState) {
    this.state = { ...initial, env: { ...initial.env } };
  }
  snapshot(): Readonly<ShellState> {
    return { ...this.state, env: { ...this.state.env } };
  }
  update(
    expectedRevision: number,
    patch: Partial<Omit<ShellState, "revision">>
  ): Readonly<ShellState> {
    if (expectedRevision !== this.state.revision)
      throw new Error("workspace_state_conflict");
    this.state = { ...this.state, ...patch, revision: expectedRevision + 1 };
    return this.snapshot();
  }
}

export function microForkName(taskId: string): string {
  const safe = taskId
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!safe) throw new Error("A task id is required for a micro-fork");
  return `avos/task/${safe}`;
}

export async function commitToolTurn(
  repo: ArtifactRepository,
  turn: number,
  metadata: CommitMetadata
): Promise<ArtifactCommit> {
  if (!Number.isSafeInteger(turn) || turn < 0) throw new Error("invalid_turn");
  const verified = validateCommitMetadata(metadata);
  return repo.commit(`turn ${turn}: ${verified.userGoal}`, verified);
}

// ── Invisible compute hypervisor ─────────────────────────────────────────────

export type ComputeTier = 1 | 2 | 3 | 4 | 5 | 6;
export type RuntimeTool = "Bash" | "Read" | "Edit" | "Browser" | "Delegate";

export interface RuntimeIntent {
  tool: RuntimeTool;
  command?: string;
  needsDurability?: boolean;
  needsScreenshot?: boolean;
  needsWebGL?: boolean;
  needsNative?: boolean;
  pythonImports?: string[];
}

export interface RuntimeRoute {
  tier: ComputeTier;
  engine: string;
  reason: string;
}

const NATIVE_PYTHON = new Set([
  "torch",
  "tensorflow",
  "cv2",
  "numpy-native",
  "scipy-native",
]);

/** Scripts describe needs; only the hypervisor selects the cheapest capable tier. */
export function routeRuntime(intent: RuntimeIntent): RuntimeRoute {
  if (
    intent.needsNative ||
    intent.pythonImports?.some((name) => NATIVE_PYTHON.has(name))
  )
    return {
      tier: 6,
      engine: "container",
      reason: "native capability required",
    };
  if (intent.tool === "Browser") {
    if (intent.needsScreenshot || intent.needsWebGL)
      return {
        tier: 5,
        engine: "chromium",
        reason: "visual browser capability required",
      };
    return { tier: 4, engine: "kitesurf", reason: "lightweight DOM browser" };
  }
  if (intent.needsDurability)
    return {
      tier: 3,
      engine: "workflow",
      reason: "durable or scheduled execution",
    };
  if (intent.tool === "Read" || intent.tool === "Edit")
    return { tier: 1, engine: "artifact-vfs", reason: "filesystem operation" };
  if (intent.pythonImports)
    return { tier: 2, engine: "pyodide", reason: "WASM Python is sufficient" };
  return { tier: 2, engine: "isolate-shell", reason: "in-isolate command" };
}

export interface ContainerLease {
  projectId: string;
  lastUsedAt: number;
}

import type { ContainerBackend } from "./types.js";
export interface ContainerRequirements {
  native?: boolean;
  gpu?: boolean;
  confidential?: boolean;
  browserAvailable?: boolean;
  localTunnelAuthorized?: boolean;
}

/** Selects a Tier 6 backend without exposing backend controls to the model. */
export function selectContainerBackend(
  input: ContainerRequirements
): ContainerBackend {
  if (input.gpu) {
    if (!input.localTunnelAuthorized)
      throw new Error("local_tunnel_not_authorized");
    return "local_workstation";
  }
  if (!input.native && !input.confidential && input.browserAvailable)
    return "webcontainer";
  return "cloudflare_container";
}

export interface EnvironmentHandoff {
  source: ContainerBackend;
  target: ContainerBackend;
  files: string[];
  terminateSource: boolean;
  installCommand: "npm ci";
}

/** Only source and lockfiles cross runtime boundaries; dependency trees never do. */
export function planEnvironmentHandoff(
  source: ContainerBackend,
  target: ContainerBackend,
  files: string[]
): EnvironmentHandoff {
  if (source === target) throw new Error("handoff_requires_distinct_backends");
  const normalized = files.map(normalizeWorkspacePath);
  if (normalized.some((path) => /(^|\/)node_modules(\/|$)/.test(path)))
    throw new Error("dependency_tree_transfer_denied");
  if (!normalized.some((path) => /\/package(?:-lock)?\.json$/.test(path)))
    throw new Error("handoff_lockfiles_required");
  return {
    source,
    target,
    files: normalized,
    terminateSource: true,
    installCommand: "npm ci",
  };
}
export function shouldStopContainer(
  lease: ContainerLease,
  now = Date.now()
): boolean {
  return now - lease.lastUsedAt >= CONTAINER_IDLE_TIMEOUT_MS;
}

/** Persistent multiplexed transport used by container and virtual-display adapters. */
export interface RuntimeBridge {
  call<T>(
    stream: string,
    method: string,
    payload: unknown,
    signal?: { readonly aborted: boolean }
  ): Promise<T>;
}

export class MultiplexedBridge implements RuntimeBridge {
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason?: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    private readonly sendRaw: (message: string) => void | Promise<void>,
    private readonly timeoutMs = 30_000
  ) {}

  async call<T>(
    stream: string,
    method: string,
    payload: unknown,
    signal?: AbortSignal
  ): Promise<T> {
    if (signal?.aborted) throw new Error("aborted");
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      const onAbort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        cleanup();
        reject(new Error("aborted"));
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        cleanup();
        reject(new Error(`bridge_call_timeout:${stream}:${method}`));
      }, this.timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value as T);
        },
        reject: (reason) => {
          cleanup();
          reject(reason);
        },
        timer,
      });
      signal?.addEventListener("abort", onAbort, { once: true });

      Promise.resolve(
        this.sendRaw(JSON.stringify({ id, stream, method, payload }))
      ).catch((err) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || !("id" in parsed)) return;
    const msg = parsed as Record<string, unknown>;
    if (typeof msg.id !== "string" || !msg.id) return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(msg.id);
    if (typeof msg.error === "string" && msg.error) {
      pending.reject(new Error(msg.error));
    } else {
      pending.resolve(msg.result);
    }
  }
}

export interface VirtualDisplay {
  capture(): Promise<Uint8Array>;
  mouse(x: number, y: number, button?: "left" | "right"): Promise<void>;
  type(text: string): Promise<void>;
}

export class ContainerVirtualDisplay implements VirtualDisplay {
  private readonly baseUrl: string;

  constructor(
    endpointUrl: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.baseUrl = endpointUrl.replace(/\/+$/, "");
  }

  async capture(): Promise<Uint8Array> {
    const res = await this.fetchImpl(`${this.baseUrl}/display/capture`, {
      method: "POST",
    });
    if (!res.ok) throw new Error(`display_capture_failed:${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async mouse(
    x: number,
    y: number,
    button: "left" | "right" = "left"
  ): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/display/mouse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x, y, button }),
    });
    if (!res.ok) throw new Error(`display_mouse_failed:${res.status}`);
  }

  async type(text: string): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/display/type`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`display_type_failed:${res.status}`);
  }
}

// ── Universal script context ─────────────────────────────────────────────────

export interface LaunchpadRuntimeContext {
  fs: ArtifactFS;
  project: {
    id: string;
    commitTurn(turn: number, metadata: CommitMetadata): Promise<ArtifactCommit>;
  };
  space: { id: string; depth: SpaceDepth };
  vault: {
    has(alias: string): Promise<boolean>;
    request(alias: string): Promise<never>;
  };
  cli: { run(command: string, args?: string[]): Promise<unknown> };
  browser: { navigate(url: string): Promise<unknown> };
  connectors: {
    call(alias: string, operation: string, input?: unknown): Promise<unknown>;
  };
}

export interface RuntimeContextAdapters {
  fs: ArtifactFS;
  repo: ArtifactRepository;
  vault: LaunchpadRuntimeContext["vault"];
  cli: LaunchpadRuntimeContext["cli"];
  browser: LaunchpadRuntimeContext["browser"];
  connectors: LaunchpadRuntimeContext["connectors"];
}

/** @deprecated Use the scoped universal createRuntimeContext export for new scripts. */
export function createLaunchpadRuntimeContext(
  space: LaunchpadSpace,
  projectId: string,
  adapters: RuntimeContextAdapters
): LaunchpadRuntimeContext {
  if (!projectId.trim()) throw new Error("Runtime context requires a project");
  return Object.freeze({
    fs: adapters.fs,
    project: {
      id: projectId,
      commitTurn: (turn: number, metadata: CommitMetadata) =>
        commitToolTurn(adapters.repo, turn, metadata),
    },
    space: { id: space.id, depth: space.depth },
    vault: adapters.vault,
    cli: adapters.cli,
    browser: adapters.browser,
    connectors: adapters.connectors,
  });
}
