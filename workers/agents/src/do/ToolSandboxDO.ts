/**
 * ToolSandboxDO — Tier-6 compute. A Cloudflare Container attached to this Durable
 * Object (via `[[containers]]` in wrangler.toml). The agent spins one up on demand to actually
 * build and test the micro-tool's code — including scripts that need a real runtime (Node,
 * Python). This is CF-native: no external service, the DO owns the container lifecycle and
 * lets it sleep when idle.
 *
 * The container runs a tiny harness (see container/server.mjs) listening on 8080:
 *   POST /build            { code }        -> { built, tests_passed, logs }
 *   POST /exec             { name, code, args } -> { ok, result?, error?, logs }
 *   POST /workspace/read   { paths? }       -> { files }
 *   POST /workspace/write  { files }        -> { ok }
 *   POST /workspace/list   {}               -> { files: string[] }
 *   POST /workspace/delete { paths }        -> { ok }
 *
 * §A1.17 Phase K addressed this DO per PROJECT (sandbox:{space}:{project}, see
 * code-runner.ts's runContainer, unchanged) so every thread's agent in a project shares one
 * container. Phase R replaced that phase's blind full-materialize/collect around every /exec
 * call: a Cloudflare Container has no native R2 mount, but pretending one exists by silently
 * syncing everything on every call is neither honest about persistence (a script "sees" R2
 * content that's really just a snapshot from the start of the call) nor cheap (a 300-file/2MB/
 * 25MB tax on every single /exec, whether the script touches files or not). The container's own
 * /workspace disk now persists across calls to the SAME warm instance with NO R2 traffic, and
 * starts genuinely empty on a cold start — an agent explicitly moves files between R2 and the
 * container via the `workspace` prebuilt's copy/move/list ops (script-engine/prebuilt/
 * workspace.ts), which call straight through to the routes above with zero DO-side R2 logic at
 * all (the R2 side of a copy is a normal R2 read/write in that prebuilt, same bucket/prefix Tier
 * 1's r2-workspace already uses).
 *
 * WS-7 (audit plan) — DO-naming exception, documented not normalized: addressed by a plain
 * `sandbox:{spaceId}:{projectId}` key, not the HMAC-SHA256(tenantId, secret):type:id convention
 * SpaceDO/NaelaoAgentDO use (G-BA01). Same server-derived-key rationale as TaskDO's exception
 * (see its file header) — spaceId/projectId here are never raw client input forwarded as-is.
 * (The legacy BusinessDO code path used to address this same container class by a separate,
 * un-tenant-scoped `sandbox:{userId}` key — that whole code path was retired along with
 * BusinessDO, so this is the only sandbox-addressing scheme left.)
 */

import { DurableObject } from "cloudflare:workers";
import { readBytesWithHash } from "../script-engine/r2-cas.js";
import { readBoundedRequestBytes, readBoundedResponseText, RequestBodyTooLargeError, verifyInternalToken } from "@naelao/http";
import { BILLING_CORE_RATE_CARD_VERSION, infraTimeToCredits } from "@naelao/billing-core";
import { reserveWorkflowBudget, finalizeWorkflowBudget } from "../workflows/report-infra-usage.js";
import { validateContainerScope, type ContainerInvocationScope } from "../script-engine/container-policy.js";
import type { InstallationScope } from "@naelao/agent-sdk";
import type { Env } from "../env.js";
import { TRUSTED_PACKAGE_HOSTS } from "../script-engine/package-egress.js";
import { isSpaceNetworkEgressDenied } from "@naelao/security";
import { workspaceCoordinatorRequest } from "../workspace/workspace-client.js";
import { validateWorkspaceScope, type WorkspaceEntry, type WorkspaceHead, type WorkspaceScope } from "../workspace/workspace-contract.js";
import { environmentArtifactObjectKey } from "../script-engine/environment-artifacts.js";

// The container runtime surface exposed on DurableObjectState (cast to stay
// version-agnostic across @cloudflare/workers-types).
interface ContainerPort {
  fetch(request: Request): Promise<Response>;
}
export interface ContainerRuntime {
  readonly running: boolean;
  readonly images?: Readonly<Record<string, string>>;
  start(opts?: { enableInternet?: boolean; image?: string; instance?: import("../script-engine/dynamic-containers.js").DynamicProfile; containerSnapshot?: { id: string }; labels?: Record<string, string> }): void;
  snapshotContainer?(options?: { name?: string }): Promise<{ id: string; size: number }>;
  interceptOutboundHttps?(host: string, binding: ContainerPort): Promise<void>;
  getTcpPort(port: number): ContainerPort;
  inspect?(): Promise<{ image: string; labels?: Record<string, string> } | null>;
  destroy?(): Promise<void>;
  stop?(signal?: string): Promise<void> | void;
}

export interface SandboxWorkspaceScope {
  spaceId: string;
  projectId?: string;
  /** Installed sidecar identity. Its files live in an installation-owned workspace,
   *  separate from the project and Space Assistant workspaces. */
  installationId?: string;
  installationScope?: InstallationScope;
  branch?: string;
  /** Host-validated grants; only the matching subtree is materialized beneath /workspace/shared. */
  sharedFilesystemGrants?: readonly { path: string; access: "READ" | "READ_WRITE" }[];
}

interface SandboxBindings {
  SCRIPTS_R2?: R2Bucket;
  CONCURRENCY_DO?: DurableObjectNamespace;
  WORKSPACE_COORDINATOR?: DurableObjectNamespace;
  UNIFIED_WORKSPACE_ENABLED?: string;
  DATA_JURISDICTION?: "eu";
  PLATFORM_SECRET?: string;
  BILLING_WORKER?: Fetcher;
  ANALYTICS?: AnalyticsEngineDataset;
  PLATFORM_DB?: D1Database;
}
type ProjectErasureState = "active" | "erased" | "unavailable";

interface WorkspacePublication {
  scope: SandboxWorkspaceScope;
  changes: Array<{ path: string; expectedHash: string | null; newHash: string | null; stagedKey?: string }>;
  createdAt?: string;
}

interface ProjectMainGenerationAttempt {
  generation: number;
  branch: string;
  token: string;
}

const HARNESS_PORT = 8080;
const MAX_WORKSPACE_FILE_BYTES = 20 * 1024 * 1024;
const MAX_WORKSPACE_BATCH_BYTES = 20 * 1024 * 1024;
const MAX_WORKSPACE_REQUEST_BYTES = 30 * 1024 * 1024;
const BASE_IDLE_WINDOW_MS = 60_000;
// A task-active hint is not proof that the next scheduled step needs this runtime. Keep the base
// container's idle exposure within its normal bound until an exact runtime lease is held.
const ACTIVE_TASK_IDLE_WINDOW_MS = BASE_IDLE_WINDOW_MS;
// Keep marketplace sidecars warm only across immediate calls from the same delegated run.
// This initial short lease should be tuned from cold-start and billed-idle measurements.
const SIDECAR_WARM_LEASE_MS = 5_000;
const WORKSPACE_ROUTES = [
  "/workspace/read",
  "/workspace/write",
  "/workspace/list",
  "/workspace/delete",
  "/workspace/rehydrate",
];

interface WorkspaceRecord { content: string; hash: string }
interface ContainerMeter { creditsPerHour?: number; tenantId: string; spaceId: string; reservationId: string; startedAt: number; expiresAt: number; allocatedAt?: number; endedAt?: number }
interface ContainerRuntimeMetrics {
  sidecar: boolean; coldStarts: number; startupMs: number; warmHits: number; warmIdleMs: number; executions: number; executionMs: number;
  workspaceBytesHydrated: number; workspaceBytesCaptured: number; workspaceBytesStaged: number; workspaceCheckpoints: number; workspaceCheckpointMs: number;
  workspaceCheckpointFailures: number; workspaceCheckpointFailureMs: number; workspaceStagingAgeMs: number;
  workspaceR2Lists: number; workspaceR2Reads: number; workspaceR2Writes: number; workspaceR2Deletes: number;
}
interface ExecutionWorkspaceMetrics {
  lists: number; reads: number; writes: number; deletes: number;
  bytesRead: number; bytesWriteAttempted: number; bytesHydrated: number; bytesCaptured: number; bytesStaged: number;
  checkpoints: number; checkpointMs: number; failedCheckpoints: number; failedCheckpointMs: number; stagingAgeMs: number;
}
interface ExecutionRecord { scope: ContainerInvocationScope; payloadHash: string; status: "prepared" | "committed" | "indeterminate"; response?: { status: number; body: string } }
type ContainerEgressProfile = "disabled" | "trusted-package-hosts";

interface StoredShellState {
  cwd: string;
  env: Record<string, string>;
  gitHead: string;
  revision: number;
  stateHash: string;
}

export function isPortableWorkspacePath(path: string): boolean {
  if (typeof path !== "string" || !path || path.length > 1024 || path.includes("\0") || path.includes("\\") || path.startsWith("/")) return false;
  const parts = path.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || new TextEncoder().encode(part).byteLength > 255)) return false;
  return !parts.some(part => [".avos", ".naelao", ".git", "node_modules", ".cache", ".turbo", ".next", ".vite", "coverage", "tmp", ".tmp", ".artifactfs-staging"].includes(part)
    || part === ".env" || part.startsWith(".env.") && part !== ".env.example");
}

export function sandboxWorkspacePrefix(scope: SandboxWorkspaceScope): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(scope.spaceId)) throw new Error("invalid workspace space");
  const project = scope.projectId;
  if (project && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(project)) throw new Error("invalid workspace project");
  if (scope.installationScope === "SPACE_ASSISTANT" && project) throw new Error("assistant_runtime_project_scope_mismatch");
  if (["SPACE_SHARED", "SPACE_USER"].includes(scope.installationScope ?? "") && project)
    throw new Error("space_runtime_project_scope_mismatch");
  if (scope.installationId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(scope.installationId)) throw new Error("invalid workspace installation");
  const branch = scope.branch?.replaceAll("\\", "/");
  if (branch && (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(branch) || branch.includes(".."))) throw new Error("invalid workspace branch");
  if (scope.installationId && ["PROJECT_BOUND", "PROJECT_SHARED", "PROJECT_USER"].includes(scope.installationScope ?? "") && !project)
    throw new Error("project_runtime_project_scope_required");
  // An installed sidecar must never resolve to the project's canonical workspace or
  // the Space Assistant's workspace. Project files use the explicit artifact path.
  const base = scope.installationId
    ? project
      ? `spaces/${scope.spaceId}/projects/${project}/extensions/${scope.installationId}/workspace/`
      : `spaces/${scope.spaceId}/space-workspace/extensions/${scope.installationId}/workspace/`
    : project
      ? `spaces/${scope.spaceId}/projects/${project}/workspace/`
      : `spaces/${scope.spaceId}/workspace/`;
  return branch ? `${base}branches/${branch}/` : base;
}

function sharedObjectKey(scope: SandboxWorkspaceScope, virtualPath: string, access: "read" | "write"): string | null {
  if (!virtualPath.startsWith("shared/")) return null;
  const relative = virtualPath.slice("shared/".length);
  if (!isPortableWorkspacePath(relative) || relative.split("/").some(part => !part || part === "." || part === ".."))
    throw new Error("sandbox_shared_path_invalid");
  const absolute = `/space/shared/${relative}`;
  const allowed = scope.installationScope === "SPACE_SHARED" && Boolean(scope.installationId)
    && (scope.sharedFilesystemGrants ?? []).some(grant => (grant.access === "READ_WRITE" || access === "read") && absolute.startsWith(grant.path));
  if (!allowed) throw new Error("sandbox_shared_filesystem_denied");
  return `spaces/${scope.spaceId}/space-workspace/shared/${relative}`;
}

function workspaceObjectKey(scope: SandboxWorkspaceScope, virtualPath: string, access: "read" | "write"): string {
  return sharedObjectKey(scope, virtualPath, access) ?? `${sandboxWorkspacePrefix(scope)}${virtualPath}`;
}

async function hashState(state: Omit<StoredShellState, "stateHash">): Promise<string> {
  const canonical = JSON.stringify({ cwd: state.cwd, env: Object.fromEntries(Object.entries(state.env).sort()), gitHead: state.gitHead, revision: state.revision });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, "0")).join("");
}

async function hashWorkspaceContent(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
  return btoa(binary);
}

function isSyncableWorkspacePath(path: string): boolean {
  const parts = path.replaceAll("\\", "/").split("/");
  return isPortableWorkspacePath(path) && !parts.some((part) =>
    [".avos", ".naelao", ".git", ".cache", ".turbo", ".next", ".vite", "coverage", "tmp", ".tmp"].includes(part) ||
    part === ".env" || part.startsWith(".env.") && part !== ".env.example"
  );
}

export class ToolSandboxDO extends DurableObject {
  private lastUsedAt = Date.now();
  private executionQueue: Promise<void> = Promise.resolve();
  private activeExecution: { id: string; scope: ContainerInvocationScope; controller: AbortController; workspaceMetrics: ExecutionWorkspaceMetrics } | undefined;

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/_internal/workspace/erase") return this.enqueueSerialized(() => this.eraseWorkspaceRuntime(request));
    const largeWorkspaceWrite = ["/workspace/write", "/workspace/state-sync", "/workspace/rehydrate"].includes(path);
    if (largeWorkspaceWrite) {
      try { await this.authenticatedScope(request); }
      catch { return Response.json({ ok: false, error: "container_scope_denied" }, { status: 403 }); }
    }
    if (request.body) {
      try {
        request = new Request(request, { body: await readBoundedRequestBytes(request, largeWorkspaceWrite ? MAX_WORKSPACE_REQUEST_BYTES : 4 * 1024 * 1024) });
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError)
          return Response.json({ ok: false, error: "request_body_too_large" }, { status: 413 });
        return Response.json({ ok: false, error: "bad_request" }, { status: 400 });
      }
    }
    if (path === "/output") return this.output(request);
    if (path === "/cancel") return this.cancel(request);
    return this.enqueueSerialized(() => ["/exec", "/shell", "/build", "/prewarm", "/computer/action", "/computer/screenshot", "/pdf/render", "/media/extract-audio", ...WORKSPACE_ROUTES].includes(path)
      ? this.executeScoped(request) : (async () => {
        try { await this.authenticatedScope(request); }
        catch { return Response.json({ ok: false, error: "container_scope_denied" }, { status: 403 }); }
        return this.handleRequest(request);
      })());
  }

  /** Serialize erasure with artifact transfers and other scoped runtime work. Erasure must not
   * acknowledge local fencing while an earlier sidecar R2 write can still land afterward. */
  protected enqueueSerialized<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.executionQueue.then(operation);
    this.executionQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  protected get container(): ContainerRuntime | undefined {
    const raw = (this.ctx as unknown as { container?: ContainerRuntime }).container;
    if (!raw) return undefined;
    return { get running() { return raw.running; }, start: options => raw.start(options),
      ...(raw.images ? { images: raw.images } : {}),
      ...(raw.snapshotContainer ? { snapshotContainer: options => raw.snapshotContainer!(options) } : {}),
      ...(raw.interceptOutboundHttps ? { interceptOutboundHttps: (host: string, binding: ContainerPort) => raw.interceptOutboundHttps!(host, binding) } : {}),
      ...(raw.inspect ? { inspect: () => raw.inspect!() } : {}), ...(raw.destroy ? { destroy: () => raw.destroy!() } : {}),
      ...(raw.stop ? { stop: (signal?: string) => raw.stop!(signal) } : {}),
      getTcpPort: port => ({ fetch: async request => {
        const token = await this.ctx.storage.get<string>("container_control_token");
        const headers = new Headers(request.headers); if (token) headers.set("x-naelao-container-control", token);
        return raw.getTcpPort(port).fetch(new Request(request, { headers }));
      } }),
    };
  }

  protected async prepareAllocation(_scope: ContainerInvocationScope): Promise<void> {}
  protected workspaceRuntimeKind(): "tool_sandbox" | "dynamic_sandbox" | "document_sandbox" | "media_sandbox" { return "tool_sandbox"; }
  protected async reserveCapacity(_scope: ContainerInvocationScope, _holder: string, _expiresAt: number): Promise<void> {}
  protected async releaseCapacity(): Promise<void> {}
  protected async beforeIdleStop(_container: ContainerRuntime): Promise<void> {}
  protected async discardCheckpoint(): Promise<void> {}
  protected allocationCreditsPerHour(): number | undefined { return undefined; }
  protected async startContainer(container: ContainerRuntime, scope: ContainerInvocationScope | null): Promise<void> {
    if (scope?.dynamicImage) throw new Error("container_dynamic_policy_required");
    container.start({ enableInternet: false });
  }
  protected async verifyContainer(container: ContainerRuntime, scope: ContainerInvocationScope | null): Promise<void> {
    if (scope?.image && (await container.inspect?.())?.image !== scope.image) throw new Error("container_deployed_image_digest_mismatch");
  }

  private async authenticatedScope(request: Request): Promise<ContainerInvocationScope> {
    const scope = JSON.parse(request.headers.get("x-naelao-container-scope") ?? "null") as ContainerInvocationScope;
    if (!scope) throw new Error("container_scope_required");
    validateContainerScope(scope);
    const bindings = this.env as SandboxBindings;
    if (!bindings.PLATFORM_SECRET || !await verifyInternalToken(request.headers.get("x-naelao-internal-token") ?? undefined, scope.tenantId, bindings.PLATFORM_SECRET)) throw new Error("container_scope_denied");
    const owner = JSON.stringify([scope.tenantId, scope.spaceId, scope.projectId]);
    const previous = await this.ctx.storage.get<string>("container_owner");
    if (previous && previous !== owner) throw new Error("container_owner_mismatch");
    await this.ctx.storage.put("container_owner", owner);
    await this.ctx.storage.put("container_invocation_scope", scope);
    return scope;
  }

  /** Persisted project-sidecar execution limits are host-enforced and only shorten the
   *  authenticated image contract timeout. The profile is read for each new execution; the
   *  resulting scope is pinned in the durable execution receipt. */
  private async applySidecarExecutionProfile(scope: ContainerInvocationScope): Promise<ContainerInvocationScope> {
    if (!scope.installationId || !scope.projectId || !scope.containerId) return scope;
    const db = (this.env as SandboxBindings).PLATFORM_DB;
    if (!db) return scope;
    const row = await db.prepare(`SELECT max_execution_seconds FROM sidecar_runtime_execution_profiles
      WHERE tenant_id=? AND space_id=? AND project_id=? AND installation_id=? AND container_id=?`)
      .bind(scope.tenantId,scope.spaceId,scope.projectId,scope.installationId,scope.containerId)
      .first<{ max_execution_seconds: number }>();
    if (!row) return scope;
    if (!Number.isSafeInteger(row.max_execution_seconds) || row.max_execution_seconds < 1 || row.max_execution_seconds > 60)
      throw new Error("sidecar_runtime_profile_unavailable");
    const next = { ...scope, timeoutMs: Math.min(scope.timeoutMs, row.max_execution_seconds * 1000) };
    await this.ctx.storage.put("container_invocation_scope", next);
    return next;
  }

  private async tenantSpaceIsActive(tenantId: string, spaceId: string): Promise<boolean> {
    const db = (this.env as SandboxBindings).PLATFORM_DB;
    // Production agents bind the platform database. Isolated container harnesses may not.
    if (!db) return true;
    try {
      const active = await db.prepare(
        `SELECT s.id FROM spaces s WHERE s.id = ? AND s.tenant_id = ? AND s.status = 'active'
         AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = s.tenant_id AND o.status = 'active')`
      ).bind(spaceId, tenantId).first<{ id: string }>();
      return Boolean(active);
    } catch {
      return false;
    }
  }

  /** The D1 tombstone is the durable write barrier for project scoped runtime work. Keep a
   * local marker after observing it so restoring D1 to an older point cannot revive this DO. */
  private async projectErasureState(scope: Pick<ContainerInvocationScope, "tenantId" | "spaceId" | "projectId">): Promise<ProjectErasureState> {
    if (!scope.projectId) return "active";
    const marker = await this.ctx.storage.get<{ tenantId: string; spaceId: string; projectId: string }>("workspace_erasure_blocked");
    if (marker) return marker.tenantId === scope.tenantId && marker.spaceId === scope.spaceId && marker.projectId === scope.projectId ? "erased" : "unavailable";
    const db = (this.env as SandboxBindings).PLATFORM_DB;
    if (!db) return "unavailable";
    try {
      const row = await db.prepare(`SELECT 1 AS erased FROM workspace_erasure_tombstones
        WHERE tenant_id=? AND space_id=? AND project_id=? LIMIT 1`)
        .bind(scope.tenantId, scope.spaceId, scope.projectId).first<{ erased: number }>();
      return row ? "erased" : "active";
    } catch {
      return "unavailable";
    }
  }

  /** Stop project execution and remove the local content cache. Provider snapshots are separate
   * external resources; retain their receipt metadata for reconciliation, while the local marker
   * permanently prevents this object from restoring them. */
  protected async blockErasedProject(scope: Pick<ContainerInvocationScope, "tenantId" | "spaceId" | "projectId">): Promise<void> {
    await this.ctx.storage.put("workspace_erasure_blocked", { ...scope, observedAt: new Date().toISOString() });
    this.activeExecution?.controller.abort();
    await this.discardCheckpoint();
    const container = this.container;
    if (container?.running) {
      if (!container.destroy) throw new Error("container_hard_stop_unsupported");
      await container.destroy();
    }
    const pending = await this.ctx.storage.get<ContainerMeter>("container_reservation_pending");
    if (pending) {
      await finalizeWorkflowBudget(this.env as Env, pending.tenantId, pending.reservationId, "release");
      await this.ctx.storage.delete("container_reservation_pending");
    }
    await this.settleMeter();
    for (const key of ["workspace_snapshot", "workspace_files", "workspace_hashes", "workspace_pending_coordinator_checkpoint", "shell_state"]) {
      await this.ctx.storage.delete(key);
    }
    const executions = await this.ctx.storage.list({ prefix: "execution:" });
    for (const key of executions.keys()) await this.ctx.storage.delete(key);
    await this.ctx.storage.delete("sidecar_warm_expires_at");
    await this.ctx.storage.put("container_status", "hibernated");
  }

  private async eraseWorkspaceRuntime(request: Request): Promise<Response> {
    const bindings = this.env as SandboxBindings;
    let body: { scope?: unknown; confirm?: unknown };
    try {
      const bytes = await readBoundedRequestBytes(request, 8 * 1024);
      body = JSON.parse(new TextDecoder().decode(bytes)) as typeof body;
    } catch { return Response.json({ error_code: "invalid_runtime_erasure_request" }, { status: 400 }); }
    if (!body.scope || !validateWorkspaceScope(body.scope) || body.confirm !== true || !bindings.PLATFORM_SECRET ||
        !await verifyInternalToken(request.headers.get("x-naelao-internal-token") ?? undefined, body.scope.tenantId, bindings.PLATFORM_SECRET)) {
      return Response.json({ error_code: "forbidden" }, { status: 403 });
    }
    const scope = body.scope;
    const existingOwner = await this.ctx.storage.get<string>("container_owner");
    if (existingOwner && existingOwner !== JSON.stringify([scope.tenantId, scope.spaceId, scope.projectId]))
      return Response.json({ error_code: "runtime_erasure_scope_mismatch" }, { status: 409 });
    const state = await this.projectErasureState(scope);
    if (state === "unavailable") return Response.json({ error_code: "workspace_erasure_check_unavailable" }, { status: 503 });
    if (state !== "erased") return Response.json({ error_code: "workspace_erasure_tombstone_required" }, { status: 409 });
    try {
      await this.blockErasedProject(scope);
      return Response.json({ erased: true, runtimeKind: this.workspaceRuntimeKind(), localStatePurged: true, providerSnapshotPurge: "not_supported" }, { headers: { "cache-control": "no-store" } });
    } catch {
      return Response.json({ error_code: "runtime_erasure_retry_required" }, { status: 503 });
    }
  }

  private async registerWorkspaceRuntime(scope: ContainerInvocationScope, request: Request): Promise<void> {
    if (!scope.projectId) return;
    const objectName = request.headers.get("x-naelao-runtime-object-name");
    const db = (this.env as SandboxBindings).PLATFORM_DB;
    // Older internal callers do not yet supply a host-derived object name. They remain protected
    // by the D1 tombstone check, but are not eligible for proactive private-state erasure yet.
    if (!objectName || objectName.length > 1024 || !db) return;
    if (objectName.includes("\0")) throw new Error("workspace_runtime_identity_invalid");
    if (this.isProjectMainRuntimeScope(scope, request)) await this.reconcileProjectMainGenerationAttempt(scope, request, db);
    const now = new Date().toISOString();
    const inserted = await db.prepare(`INSERT INTO workspace_runtime_registry
      (tenant_id,space_id,project_id,runtime_kind,object_name,branch,installation_id,first_seen_at,last_seen_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,space_id,project_id,runtime_kind,object_name)
      DO UPDATE SET branch=excluded.branch,installation_id=excluded.installation_id,last_seen_at=excluded.last_seen_at,
        erasure_notified_at=NULL,last_erasure_error=NULL`)
      .bind(scope.tenantId, scope.spaceId, scope.projectId, this.workspaceRuntimeKind(), objectName,
        scope.workspaceBranch ?? "", scope.installationId ?? null, now, now).run();
    if (!inserted.meta.changes) throw new Error("workspace_runtime_registry_write_failed");
    if (this.isProjectMainRuntimeScope(scope, request)) {
      const branch = scope.workspaceBranch ?? "main";
      const generation = await this.ctx.storage.get<number>("workspace_runtime_generation") ?? 0;
      const main = await db.prepare(`INSERT INTO project_main_runtime_registry
        (tenant_id,space_id,project_id,runtime_kind,runtime_object_name,allocation_generation,fencing_token,active_branch,state,last_seen_at)
        VALUES (?,?,?,'dynamic_sandbox',?,?,0,?,'registered',?)
        ON CONFLICT(tenant_id,space_id,project_id) DO UPDATE SET
          fencing_token=project_main_runtime_registry.fencing_token + CASE WHEN project_main_runtime_registry.active_branch<>excluded.active_branch THEN 1 ELSE 0 END,
          active_branch=excluded.active_branch,last_seen_at=excluded.last_seen_at
        WHERE project_main_runtime_registry.runtime_object_name=excluded.runtime_object_name
          AND project_main_runtime_registry.allocation_generation=excluded.allocation_generation
          AND project_main_runtime_registry.state<>'erased'`)
        .bind(scope.tenantId, scope.spaceId, scope.projectId, objectName, generation, branch, now).run();
      if (!main.meta.changes) throw new Error("project_main_runtime_registry_write_failed");
    }
  }

  private async reconcileProjectMainGenerationAttempt(scope: ContainerInvocationScope, request: Request, db: D1Database): Promise<void> {
    const attempt = await this.ctx.storage.get<ProjectMainGenerationAttempt>("project_main_generation_attempt");
    if (!attempt || !Number.isSafeInteger(attempt.generation) || attempt.generation < 1 || !attempt.token
      || attempt.branch !== (scope.workspaceBranch ?? "main")) return;
    const recovered = await db.prepare(`UPDATE project_main_runtime_registry /* recover-project-main-generation */ SET last_seen_at=?
      WHERE tenant_id=? AND space_id=? AND project_id=? AND runtime_object_name=? AND allocation_generation=? AND allocation_token=? AND active_branch=?`)
      .bind(new Date().toISOString(), scope.tenantId, scope.spaceId, scope.projectId,
        request.headers.get("x-naelao-runtime-object-name"), attempt.generation, attempt.token, attempt.branch).run();
    if (recovered.meta.changes) {
      const localGeneration = await this.ctx.storage.get<number>("workspace_runtime_generation") ?? 0;
      if (localGeneration < attempt.generation) await this.ctx.storage.put("workspace_runtime_generation", attempt.generation);
    }
  }

  private async reserveProjectMainGeneration(scope: ContainerInvocationScope, request: Request): Promise<number | undefined> {
    if (!this.isProjectMainRuntimeScope(scope, request)) return undefined;
    const db = (this.env as SandboxBindings).PLATFORM_DB;
    if (!db) throw new Error("project_main_runtime_registry_unavailable");
    const branch = scope.workspaceBranch ?? "main";
    const localGeneration = await this.ctx.storage.get<number>("workspace_runtime_generation") ?? 0;
    let attempt = await this.ctx.storage.get<ProjectMainGenerationAttempt>("project_main_generation_attempt");
    if (!attempt || attempt.generation < localGeneration || attempt.generation > localGeneration + 1 || attempt.branch !== branch) {
      attempt = { generation: localGeneration + 1, branch, token: crypto.randomUUID() };
      // Persist the idempotency token before D1. It lets a retry discover a committed claim
      // when the response is lost, without accepting a different allocation's generation.
      await this.ctx.storage.put("project_main_generation_attempt", attempt);
    }
    const objectName = request.headers.get("x-naelao-runtime-object-name");
    const timestamp = new Date().toISOString();
    let claimed = await db.prepare(`UPDATE project_main_runtime_registry /* retry-project-main-generation */
      SET state='recovery_required',last_seen_at=? WHERE tenant_id=? AND space_id=? AND project_id=? AND runtime_object_name=?
        AND allocation_generation=? AND allocation_token=? AND active_branch=? AND state<>'erased'`)
      .bind(timestamp, scope.tenantId, scope.spaceId, scope.projectId, objectName, attempt.generation, attempt.token, branch).run();
    if (!claimed.meta.changes && attempt.generation === localGeneration + 1) {
      claimed = await db.prepare(`UPDATE project_main_runtime_registry /* claim-project-main-generation */
        SET allocation_generation=?,allocation_token=?,state='recovery_required',last_seen_at=?
        WHERE tenant_id=? AND space_id=? AND project_id=? AND runtime_object_name=? AND allocation_generation=? AND active_branch=? AND state<>'erased'`)
        .bind(attempt.generation, attempt.token, timestamp, scope.tenantId, scope.spaceId, scope.projectId,
          objectName, localGeneration, branch).run();
    }
    if (!claimed.meta.changes) throw new Error("project_main_runtime_registry_write_failed");
    if (localGeneration < attempt.generation) await this.ctx.storage.put("workspace_runtime_generation", attempt.generation);
    return attempt.generation;
  }

  private async activateProjectMainGeneration(scope: ContainerInvocationScope, request: Request): Promise<void> {
    if (!this.isProjectMainRuntimeScope(scope, request)) return;
    const db = (this.env as SandboxBindings).PLATFORM_DB;
    if (!db) throw new Error("project_main_runtime_registry_unavailable");
    const generation = await this.ctx.storage.get<number>("workspace_runtime_generation") ?? 0;
    const branch = scope.workspaceBranch ?? "main";
    const activated = await db.prepare(`UPDATE project_main_runtime_registry /* activate-project-main-generation */
      SET state='active',last_seen_at=? WHERE tenant_id=? AND space_id=? AND project_id=? AND runtime_object_name=?
        AND allocation_generation=? AND active_branch=? AND state<>'erased'`)
      .bind(new Date().toISOString(), scope.tenantId, scope.spaceId, scope.projectId,
        request.headers.get("x-naelao-runtime-object-name"), generation, branch).run();
    if (!activated.meta.changes) throw new Error("project_main_runtime_registry_write_failed");
    await this.ctx.storage.delete("project_main_generation_attempt");
  }

  private isProjectMainRuntimeScope(scope: ContainerInvocationScope, request: Request): boolean {
    if (this.workspaceRuntimeKind() !== "dynamic_sandbox" || !scope.projectId || scope.installationId
      || scope.workspaceBranch?.startsWith("race/")) return false;
    return request.headers.get("x-naelao-runtime-object-name") === `sandbox:${scope.spaceId}:${scope.projectId}`;
  }

  /** One active writer per project main Container. Race branches have different DO names. */
  private async acquireProjectMainWriter(scope: ContainerInvocationScope): Promise<boolean> {
    return this.ctx.storage.transaction(async (tx) => {
      const now = Date.now();
      const current = await tx.get<{ executionId: string; expiresAt: number }>("project_main_writer_admission");
      if (current && current.executionId !== scope.executionId && current.expiresAt > now) return false;
      await tx.put("project_main_writer_admission", { executionId: scope.executionId, expiresAt: now + 120_000 });
      return true;
    });
  }

  private async releaseProjectMainWriter(executionId: string): Promise<void> {
    await this.ctx.storage.transaction(async (tx) => {
      const current = await tx.get<{ executionId: string }>("project_main_writer_admission");
      if (current?.executionId === executionId) await tx.delete("project_main_writer_admission");
    });
  }

  private async requireProjectNotErased(scope: Pick<ContainerInvocationScope, "tenantId" | "spaceId" | "projectId">): Promise<ProjectErasureState> {
    const state = await this.projectErasureState(scope);
    if (state === "erased") await this.blockErasedProject(scope);
    return state;
  }

  /** Package-host interception is still network egress. Resolve it from authoritative Space
   * policy on every scoped execution; a missing/unavailable policy store must never enable it. */
  private async packageEgressProfile(scope: ContainerInvocationScope): Promise<ContainerEgressProfile> {
    const db = (this.env as SandboxBindings).PLATFORM_DB;
    if (!db || await isSpaceNetworkEgressDenied(db, scope.spaceId)) return "disabled";
    return "trusted-package-hosts";
  }

  private async output(request: Request): Promise<Response> {
    let scope: ContainerInvocationScope;
    try { scope = await this.authenticatedScope(request); } catch { return Response.json({ error: "container_scope_denied" }, { status: 403 }); }
    if (!await this.tenantSpaceIsActive(scope.tenantId, scope.spaceId)) return Response.json({ ok: false, error: "tenant_suspended" }, { status: 403 });
    const erasure = await this.requireProjectNotErased(scope);
    if (erasure === "erased") return Response.json({ ok: false, error: "workspace_project_erased" }, { status: 410 });
    if (erasure === "unavailable") return Response.json({ ok: false, error: "workspace_erasure_check_unavailable" }, { status: 503 });
    const record = await this.ctx.storage.get<ExecutionRecord>("execution:" + scope.executionId);
    if (!record || JSON.stringify(record.scope) !== JSON.stringify(scope)) return Response.json({ error: "container_execution_not_found" }, { status: 404 });
    if (!this.container?.running) return Response.json({ stdout: "", stderr: "" });
    return this.container.getTcpPort(HARNESS_PORT).fetch(new Request("http://sandbox/output", {
      headers: { "x-naelao-execution-id": scope.executionId }, signal: request.signal,
    }));
  }

  private async ensureMeter(scope: ContainerInvocationScope): Promise<void> {
    if (!await this.tenantSpaceIsActive(scope.tenantId, scope.spaceId)) throw new Error("tenant_suspended");
    const existing = await this.ctx.storage.get<ContainerMeter>("container_meter");
    if (existing?.endedAt !== undefined) await this.settleMeter();
    if (existing && existing.endedAt === undefined) {
      if (existing.expiresAt <= Date.now() + scope.timeoutMs) { await this.stopContainer(); throw new Error("container_capacity_reservation_expired_retry"); }
      return;
    }
    const now = Date.now();
    const creditsPerHour = this.allocationCreditsPerHour();
    const meter: ContainerMeter = { ...(creditsPerHour === undefined ? {} : { creditsPerHour }), tenantId: scope.tenantId, spaceId: scope.spaceId, reservationId: "container:" + crypto.randomUUID(), startedAt: now, expiresAt: now + 360000 };
    // Persist the reservation intent before contacting billing so retries use the same key.
    let pending = await this.ctx.storage.get<ContainerMeter>("container_reservation_pending") ?? meter;
    if (pending.expiresAt <= now) {
      await finalizeWorkflowBudget(this.env as Env, pending.tenantId, pending.reservationId, "release");
      pending = meter;
    }
    await this.ctx.storage.put("container_reservation_pending", pending);
    await this.ctx.storage.setAlarm(pending.expiresAt);
    if (pending.creditsPerHour !== meter.creditsPerHour) throw new Error("container_pending_profile_changed_retry_after_expiry");
    await this.reserveCapacity(scope, pending.reservationId, pending.expiresAt);
    await reserveWorkflowBudget(this.env as Env, pending.tenantId, pending.spaceId, pending.reservationId,
      "container:" + scope.spaceId + ":" + (scope.projectId ?? "assistant"), pending.creditsPerHour === undefined ? infraTimeToCredits("container", 360000) : Math.ceil(pending.creditsPerHour / 10), pending.expiresAt,
      { ...(scope.projectId ? { projectId: scope.projectId } : {}), ...(scope.installationId ? { installationId: scope.installationId } : {}), runtimeTier: 5 });
    if (pending.expiresAt <= Date.now() + scope.timeoutMs) {
      await finalizeWorkflowBudget(this.env as Env, pending.tenantId, pending.reservationId, "release");
      await this.ctx.storage.delete("container_reservation_pending");
      throw new Error("container_capacity_reservation_expired_retry");
    }
    if (!await this.tenantSpaceIsActive(scope.tenantId, scope.spaceId)) {
      await finalizeWorkflowBudget(this.env as Env, pending.tenantId, pending.reservationId, "release");
      await this.ctx.storage.delete("container_reservation_pending");
      throw new Error("tenant_suspended");
    }
    await this.ctx.storage.put("container_meter", pending);
    await this.ctx.storage.delete("container_reservation_pending");
  }

  private async settleMeter(): Promise<void> {
    const meter = await this.ctx.storage.get<ContainerMeter>("container_meter");
    if (!meter) { await this.releaseCapacity(); return; }
    meter.endedAt ??= Date.now();
    await this.ctx.storage.put("container_meter", meter);
    const allocatedMs = meter.allocatedAt === undefined ? 0 : Math.max(0, meter.endedAt - meter.allocatedAt);
    const credits = meter.creditsPerHour === undefined ? infraTimeToCredits("container", allocatedMs) : Math.ceil(meter.creditsPerHour * allocatedMs / 3600000);
    await finalizeWorkflowBudget(this.env as Env, meter.tenantId, meter.reservationId, "settle", credits);
    await this.ctx.storage.put("last_container_gas", { ...meter, credits });
    const metrics = await this.ctx.storage.get<ContainerRuntimeMetrics>("container_runtime_metrics");
    const analytics = (this.env as unknown as SandboxBindings).ANALYTICS;
    if (metrics && analytics) {
      try {
        analytics.writeDataPoint({
          blobs: ["container.runtime.lifecycle", metrics.sidecar ? "marketplace-sidecar" : "base", "tool-sandbox", "", "", "", "", "", "workspace-metrics-v1"],
          doubles: [allocatedMs, credits, metrics.coldStarts, metrics.startupMs, metrics.warmHits, metrics.warmIdleMs, metrics.executions, metrics.executionMs,
            metrics.workspaceBytesHydrated, metrics.workspaceBytesCaptured, metrics.workspaceBytesStaged, metrics.workspaceCheckpoints, metrics.workspaceCheckpointMs,
            metrics.workspaceR2Lists, metrics.workspaceR2Reads, metrics.workspaceR2Writes, metrics.workspaceR2Deletes],
        });
        analytics.writeDataPoint({
          blobs: ["container.runtime.lifecycle_v2", metrics.sidecar ? "marketplace-sidecar" : "base", "tool-sandbox", "", "", "", "", "", "workspace-metrics-v2"],
          doubles: [allocatedMs, credits, metrics.coldStarts, metrics.startupMs, metrics.warmHits, metrics.warmIdleMs, metrics.executions, metrics.executionMs,
            metrics.workspaceBytesHydrated, metrics.workspaceBytesCaptured, metrics.workspaceBytesStaged, metrics.workspaceCheckpoints, metrics.workspaceCheckpointMs,
            metrics.workspaceR2Lists, metrics.workspaceR2Reads, metrics.workspaceR2Writes, metrics.workspaceR2Deletes,
            metrics.workspaceCheckpointFailures, metrics.workspaceCheckpointFailureMs, metrics.workspaceStagingAgeMs],
        });
        const effectiveCreditsPerHour = meter.creditsPerHour ?? infraTimeToCredits("container", 3_600_000);
        analytics.writeDataPoint({
          blobs: ["container.runtime.pricing", metrics.sidecar ? "marketplace-sidecar" : "base", "internal_credits", BILLING_CORE_RATE_CARD_VERSION, "", "", "", "", "container-pricing-v1"],
          doubles: [allocatedMs, credits, effectiveCreditsPerHour, meter.creditsPerHour === undefined ? 0 : 1],
        });
      } catch { /* telemetry must never delay or prevent billing settlement */ }
    }
    await this.ctx.storage.delete("container_runtime_metrics");
    await this.ctx.storage.delete("sidecar_last_active_at");
    await this.ctx.storage.delete("container_meter");
    await this.releaseCapacity();
  }

  private async updateRuntimeMetrics(update: Partial<Record<keyof Omit<ContainerRuntimeMetrics, "sidecar">, number>>, sidecar?: boolean): Promise<void> {
    const defaults: ContainerRuntimeMetrics = { sidecar: sidecar === true, coldStarts: 0, startupMs: 0, warmHits: 0, warmIdleMs: 0, executions: 0, executionMs: 0,
      workspaceBytesHydrated: 0, workspaceBytesCaptured: 0, workspaceBytesStaged: 0, workspaceCheckpoints: 0, workspaceCheckpointMs: 0,
      workspaceCheckpointFailures: 0, workspaceCheckpointFailureMs: 0, workspaceStagingAgeMs: 0,
      workspaceR2Lists: 0, workspaceR2Reads: 0, workspaceR2Writes: 0, workspaceR2Deletes: 0 };
    const execution = this.activeExecution?.workspaceMetrics;
    if (execution) {
      execution.bytesHydrated += Math.max(0, update.workspaceBytesHydrated ?? 0);
      execution.bytesCaptured += Math.max(0, update.workspaceBytesCaptured ?? 0);
      execution.bytesStaged += Math.max(0, update.workspaceBytesStaged ?? 0);
      execution.checkpoints += Math.max(0, update.workspaceCheckpoints ?? 0);
      execution.checkpointMs += Math.max(0, update.workspaceCheckpointMs ?? 0);
      execution.failedCheckpoints += Math.max(0, update.workspaceCheckpointFailures ?? 0);
      execution.failedCheckpointMs += Math.max(0, update.workspaceCheckpointFailureMs ?? 0);
      execution.stagingAgeMs += Math.max(0, update.workspaceStagingAgeMs ?? 0);
    }
    const current = { ...defaults, ...await this.ctx.storage.get<Partial<ContainerRuntimeMetrics>>("container_runtime_metrics") };
    if (sidecar !== undefined) current.sidecar = sidecar;
    for (const [key, value] of Object.entries(update) as Array<[keyof typeof update, number]>) current[key] += value;
    await this.ctx.storage.put("container_runtime_metrics", current);
  }

  protected async stopContainer(preserveSnapshot = false): Promise<void> {
    if (!preserveSnapshot) await this.discardCheckpoint();
    const container = this.container;
    if (container?.running) {
      if (preserveSnapshot) await this.beforeIdleStop(container);
      if (!container.destroy) throw new Error("container_hard_stop_unsupported");
      await container.destroy();
    }
    await this.settleMeter();
    await this.ctx.storage.delete("sidecar_warm_expires_at");
    await this.ctx.storage.put("container_status", "hibernated");
  }

  private async cancel(request: Request): Promise<Response> {
    let scope: ContainerInvocationScope;
    try { scope = await this.authenticatedScope(request); } catch { return Response.json({ ok: false, error: "container_scope_denied" }, { status: 403 }); }
    if (!await this.tenantSpaceIsActive(scope.tenantId, scope.spaceId)) return Response.json({ ok: false, error: "tenant_suspended" }, { status: 403 });
    const record = await this.ctx.storage.get<ExecutionRecord>("execution:" + scope.executionId);
    if (!record || record.scope.runId !== scope.runId || record.scope.actorId !== scope.actorId || record.scope.installationId !== scope.installationId) return Response.json({ ok: false, error: "container_execution_not_found" }, { status: 404 });
    if (record.status === "committed") return Response.json({ ok: true, already_completed: true });
    await this.ctx.storage.put("cancelled:" + scope.executionId, true);
    if (this.activeExecution?.id === scope.executionId) {
      this.activeExecution.controller.abort();
      await this.container?.getTcpPort(HARNESS_PORT).fetch(new Request("http://sandbox/cancel", { method: "POST", headers: { "x-naelao-execution-id": scope.executionId } })).catch(() => undefined);
    }
    return Response.json({ ok: true });
  }

  private async executeScoped(request: Request): Promise<Response> {
    let scope: ContainerInvocationScope;
    try { scope = await this.authenticatedScope(request); } catch (error) { return Response.json({ ok: false, error: String(error) }, { status: 403 }); }
    try { scope = await this.applySidecarExecutionProfile(scope); }
    catch { return Response.json({ ok: false, error: "sidecar_runtime_profile_unavailable" }, { status: 503 }); }
    if (!await this.tenantSpaceIsActive(scope.tenantId, scope.spaceId)) {
      await this.discardCheckpoint();
      return Response.json({ ok: false, error: "tenant_suspended" }, { status: 403 });
    }
    const erasure = await this.requireProjectNotErased(scope);
    if (erasure === "erased") return Response.json({ ok: false, error: "workspace_project_erased" }, { status: 410 });
    if (erasure === "unavailable") return Response.json({ ok: false, error: "workspace_erasure_check_unavailable" }, { status: 503 });
    const mainWriter = this.isProjectMainRuntimeScope(scope, request);
    if (this.workspaceRuntimeKind() === "dynamic_sandbox" && scope.projectId && !scope.installationId
      && !scope.workspaceBranch?.startsWith("race/") && !mainWriter) {
      return Response.json({ ok: false, error: "project_main_runtime_identity_mismatch" }, { status: 409 });
    }
    const body = await request.clone().text();
    const payloadHash = await hashWorkspaceContent(new URL(request.url).pathname + body);
    const key = "execution:" + scope.executionId;
    const previous = await this.ctx.storage.get<ExecutionRecord>(key);
    if (previous) {
      if (previous.payloadHash !== payloadHash || JSON.stringify(previous.scope) !== JSON.stringify(scope)) return Response.json({ ok: false, error: "container_execution_conflict" }, { status: 409 });
      if (previous.status === "committed" && previous.response) return new Response(previous.response.body, { status: previous.response.status, headers: { "content-type": "application/json" } });
      return Response.json({ ok: false, error: "container_execution_reconciliation_required" }, { status: 409 });
    }
    if (mainWriter) {
      let admitted: boolean;
      try { admitted = await this.acquireProjectMainWriter(scope); }
      catch { return Response.json({ ok: false, error: "project_main_writer_admission_unavailable" }, { status: 503 }); }
      if (!admitted) return Response.json({ ok: false, error: "project_main_writer_busy" }, { status: 423 });
    }
    try {
      await this.registerWorkspaceRuntime(scope, request);
      await this.ctx.storage.put(key, { scope, payloadHash, status: "prepared" } satisfies ExecutionRecord);
    } catch {
      if (mainWriter) await this.releaseProjectMainWriter(scope.executionId).catch(() => undefined);
      return Response.json({ ok: false, error: "workspace_runtime_registry_unavailable" }, { status: 503 });
    }
    let retainSidecarWarm = false;
    let metered = false;
    const startedAt = Date.now();
    const sidecarWasWarm = Boolean(scope.installationId && this.container?.running);
    const controller = new AbortController();
    this.activeExecution = { id: scope.executionId, scope, controller, workspaceMetrics: {
      lists: 0, reads: 0, writes: 0, deletes: 0, bytesRead: 0, bytesWriteAttempted: 0,
      bytesHydrated: 0, bytesCaptured: 0, bytesStaged: 0, checkpoints: 0, checkpointMs: 0,
      failedCheckpoints: 0, failedCheckpointMs: 0, stagingAgeMs: 0,
    } };
    const abort = () => controller.abort();
    let executionLimitExceeded = false;
    request.signal.addEventListener("abort", abort, { once: true });
    const remaining = Math.min(scope.timeoutMs, scope.deadline - Date.now());
    const timer = setTimeout(() => { executionLimitExceeded = true; abort(); }, Math.max(1, remaining));
    const headers = new Headers(request.headers);
    headers.set("x-naelao-execution-id", scope.executionId); headers.set("x-naelao-timeout-ms", String(Math.max(1, remaining - 1000)));
    try {
      if (request.signal.aborted || await this.ctx.storage.get("cancelled:" + scope.executionId)) throw new Error("container_cancelled");
      await this.prepareAllocation(scope);
      const requestedEgressProfile = await this.packageEgressProfile(scope);
      const previousEgressProfile = await this.ctx.storage.get<ContainerEgressProfile>("container_egress_profile");
      if (this.container?.running && previousEgressProfile !== requestedEgressProfile) {
        // Network interception is configured for a container's lifetime. Recreate it when
        // policy changes so a warm container cannot retain package egress after an air-gap.
        await this.stopContainer();
        await this.ctx.storage.delete("container_egress_profile");
      }
      await this.ensureMeter(scope);
      metered = true;
      if (sidecarWasWarm) {
        const lastActiveAt = await this.ctx.storage.get<number>("sidecar_last_active_at");
        await this.updateRuntimeMetrics({ warmHits: 1, warmIdleMs: lastActiveAt === undefined ? 0 : Math.max(0, startedAt - lastActiveAt) }, true);
      }
      await this.updateRuntimeMetrics({ executions: 1 }, Boolean(scope.installationId));
      if (controller.signal.aborted) throw new Error("container_cancelled_or_deadline");
      // Recheck policy while a bounded container step is active. If an owner enables the
      // Space air-gap mid-run, alarm() hard-stops the container instead of waiting for the
      // next user/tool invocation. Container steps already have a strict deadline.
      await this.ctx.storage.setAlarm(Math.min(Date.now() + 1000, scope.deadline));
      const response = await Promise.race([
        this.handleRequest(new Request(request, { headers, signal: controller.signal })),
        new Promise<Response>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("container_cancelled_or_deadline")), { once: true })),
      ]);
      if (controller.signal.aborted) throw new Error("container_cancelled_or_deadline");
      const erasureAfterExecution = await this.projectErasureState(scope);
      if (erasureAfterExecution !== "active") {
        if (erasureAfterExecution === "erased") await this.blockErasedProject(scope);
        throw new Error(erasureAfterExecution === "erased" ? "workspace_project_erased" : "workspace_erasure_check_unavailable");
      }
      if (response.headers.get("x-naelao-container-tainted") === "1") throw new Error("container_guest_cleanup_unverified");
      retainSidecarWarm = Boolean(scope.installationId && response.ok);
      if (new URL(request.url).pathname !== "/computer/screenshot") {
        const responseBody = await readBoundedResponseText(response.clone(), 2 * 1024 * 1024);
        await this.ctx.storage.put(key, { scope, payloadHash, status: "committed", response: { status: response.status, body: responseBody } } satisfies ExecutionRecord);
      } else await this.ctx.storage.put(key, { scope, payloadHash, status: "indeterminate" } satisfies ExecutionRecord);
      return response;
    } catch (error) {
      controller.abort();
      // Once erasure is durable, do not recreate an execution record that the erasure barrier
      // removed. For an unavailable check, keep the indeterminate receipt for reconciliation.
      if (await this.projectErasureState(scope) !== "erased")
        await this.ctx.storage.put(key, { scope, payloadHash, status: "indeterminate" } satisfies ExecutionRecord);
      if (metered) {
        await this.updateRuntimeMetrics({ executionMs: Math.max(0, Date.now() - startedAt) }, Boolean(scope.installationId));
        await this.flushExecutionWorkspaceMetrics(scope);
        metered = false;
      }
      await this.stopContainer().catch(() => this.ctx.storage.setAlarm(Date.now() + 1000));
      const message = executionLimitExceeded
        ? `container_execution_time_limit_exceeded: maximum ${scope.timeoutMs}ms; move waits and schedules to a Durable Workflow and keep each container step bounded`
        : String(error);
      return Response.json({ ok: false, error: message, workspace_may_require_reconciliation: true }, { status: 409 });
    } finally {
      clearTimeout(timer); request.signal.removeEventListener("abort", abort);
      if (metered) {
        await this.updateRuntimeMetrics({ executionMs: Math.max(0, Date.now() - startedAt) }, Boolean(scope.installationId));
        await this.flushExecutionWorkspaceMetrics(scope);
        metered = false;
      }
      this.activeExecution = undefined;
      if (mainWriter) await this.releaseProjectMainWriter(scope.executionId).catch(() => undefined);
      if (scope.installationId) {
        await this.ctx.storage.delete("task_active");
        if (retainSidecarWarm) {
          const expiresAt = Date.now() + SIDECAR_WARM_LEASE_MS;
          await this.ctx.storage.put("sidecar_warm_expires_at", expiresAt);
          await this.ctx.storage.put("sidecar_last_active_at", Date.now());
          await this.ctx.storage.setAlarm(Math.min(expiresAt, (await this.ctx.storage.get<ContainerMeter>("container_meter"))?.expiresAt ?? Infinity));
        } else await this.stopContainer().catch(() => this.ctx.storage.setAlarm(Date.now() + 1000));
      }
    }
  }

  private workspacePrefix(scope: SandboxWorkspaceScope): string {
    return sandboxWorkspacePrefix(scope);
  }

  private recordWorkspaceR2(operation: "lists" | "reads" | "writes" | "deletes", bytes = 0): void {
    const metrics = this.activeExecution?.workspaceMetrics;
    if (!metrics) return;
    metrics[operation]++;
    if (operation === "reads") metrics.bytesRead += Math.max(0, bytes);
    if (operation === "writes") metrics.bytesWriteAttempted += Math.max(0, bytes);
  }

  private async readWorkspaceBytes(bucket: R2Bucket, key: string) {
    this.recordWorkspaceR2("reads");
    const result = await readBytesWithHash(bucket, key);
    if (result) {
      const metrics = this.activeExecution?.workspaceMetrics;
      if (metrics) metrics.bytesRead += result.bytes.byteLength;
    }
    return result;
  }

  private async flushExecutionWorkspaceMetrics(scope: ContainerInvocationScope): Promise<void> {
    const active = this.activeExecution;
    if (active?.id !== scope.executionId) return;
    const metrics = active.workspaceMetrics;
    await this.updateRuntimeMetrics({ workspaceR2Lists: metrics.lists, workspaceR2Reads: metrics.reads, workspaceR2Writes: metrics.writes, workspaceR2Deletes: metrics.deletes });
    const analytics = (this.env as unknown as SandboxBindings).ANALYTICS;
    try {
      analytics?.writeDataPoint({ blobs: ["container.runtime.execution", scope.installationId ? "marketplace-sidecar" : "base", "tool-sandbox", "", "", "", "", "", "workspace-metrics-v1"], doubles: [metrics.lists, metrics.reads, metrics.writes, metrics.deletes] });
      analytics?.writeDataPoint({
        blobs: ["container.runtime.execution_v2", scope.installationId ? "marketplace-sidecar" : "base", "tool-sandbox", "", "", "", "", "", "workspace-metrics-v2"],
        doubles: [metrics.lists, metrics.reads, metrics.writes, metrics.deletes,
          metrics.bytesRead, metrics.bytesWriteAttempted, metrics.bytesHydrated, metrics.bytesCaptured, metrics.bytesStaged,
          metrics.checkpoints, metrics.checkpointMs, metrics.failedCheckpoints, metrics.failedCheckpointMs, metrics.stagingAgeMs],
      });
    } catch { /* telemetry must never delay execution cleanup */ }
    for (const key of Object.keys(metrics) as Array<keyof ExecutionWorkspaceMetrics>) metrics[key] = 0;
  }

  private async recordWorkspaceStagingAge(createdAt: unknown): Promise<void> {
    if (typeof createdAt !== "string") return;
    const createdMs = Date.parse(createdAt);
    if (!Number.isFinite(createdMs) || createdMs > Date.now()) return;
    try { await this.updateRuntimeMetrics({ workspaceStagingAgeMs: Math.min(Date.now() - createdMs, 365 * 24 * 60 * 60_000) }); }
    catch { /* telemetry must not change publication or recovery decisions */ }
  }

  private async *listR2Workspace(prefix: string): AsyncGenerator<{ path: string; bytes: Uint8Array; hash: string }> {
    const bucket = (this.env as unknown as SandboxBindings).SCRIPTS_R2;
    if (!bucket) throw new Error("Canonical workspace R2 binding is unavailable");
    let cursor: string | undefined;
    do {
      this.recordWorkspaceR2("lists");
      const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}), limit: 1000, include: ["customMetadata"] } as R2ListOptions & { include: string[] });
      for (const item of page.objects) {
        if (item.customMetadata?.deleted === "true") continue;
        const path = item.key.slice(prefix.length);
        if (prefix.endsWith("/workspace/") && path.startsWith("branches/")) continue;
        if (!isSyncableWorkspacePath(path)) continue;
        const object = await this.readWorkspaceBytes(bucket, item.key);
        if (!object) throw new Error(`Workspace object disappeared during hydration: ${path}`);
        yield { path, bytes: object.bytes, hash: object.hash };
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }

  private async hydrateWorkspace(container: ContainerRuntime, scope: SandboxWorkspaceScope): Promise<void> {
    if ((this.env as unknown as SandboxBindings).UNIFIED_WORKSPACE_ENABLED === "true" && !scope.installationId) {
      await this.hydrateUnifiedWorkspace(container, scope);
      return;
    }
    const prefix = this.workspacePrefix(scope);
    const expectedHashes: Record<string, string> = {};
    let hydratedBytes = 0;
    for await (const { path, bytes, hash } of this.listR2Workspace(prefix)) {
      // /workspace/shared is reserved as a virtual mount, never an alias into the private tree.
      if (path.startsWith("shared/")) continue;
      const response = await container.getTcpPort(HARNESS_PORT).fetch(new Request("http://sandbox/workspace/write", {
        method: "POST", headers: { "content-type": "application/json", "x-avos-restore": "1" },
        body: JSON.stringify({ files_base64: { [path]: bytesToBase64(bytes) } }),
      }));
      if (!response.ok) throw new Error(`Workspace hydration failed (${response.status}): ${path}`);
      expectedHashes[path] = hash;
      hydratedBytes += bytes.byteLength;
    }
    for (const grant of scope.sharedFilesystemGrants ?? []) {
      if (scope.installationScope !== "SPACE_SHARED" || !scope.installationId) throw new Error("sandbox_shared_filesystem_denied");
      const relativePrefix = grant.path.slice("/space/shared/".length);
      const sharedPrefix = `spaces/${scope.spaceId}/space-workspace/shared/${relativePrefix}`;
      for await (const { path, bytes, hash } of this.listR2Workspace(sharedPrefix)) {
        const virtualPath = `shared/${relativePrefix}${path}`;
        if (!isSyncableWorkspacePath(virtualPath)) continue;
        const response = await container.getTcpPort(HARNESS_PORT).fetch(new Request("http://sandbox/workspace/write", {
          method: "POST", headers: { "content-type": "application/json", "x-avos-restore": "1" },
          body: JSON.stringify({ files_base64: { [virtualPath]: bytesToBase64(bytes) } }),
        }));
        if (!response.ok) throw new Error(`Shared workspace hydration failed (${response.status}): ${virtualPath}`);
        expectedHashes[virtualPath] = hash;
        hydratedBytes += bytes.byteLength;
      }
    }
    // A second runtime may have deleted a canonical file while this container was warm.
    // Remove only previously tracked deliverables; local dependencies/control files are not
    // canonical workspace data and must not be erased by a refresh.
    const previous = await this.ctx.storage.get<Record<string, string>>("workspace_hashes") ?? {};
    const removed = Object.keys(previous).filter(path => isSyncableWorkspacePath(path) && !(path in expectedHashes));
    if (removed.length) {
      const response = await container.getTcpPort(HARNESS_PORT).fetch(new Request("http://sandbox/workspace/delete", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paths: removed }),
      }));
      if (!response.ok) throw new Error(`Workspace refresh deletion failed (${response.status})`);
    }
    await this.ctx.storage.put("workspace_scope", scope);
    await this.ctx.storage.put("workspace_hashes", expectedHashes);
    if (hydratedBytes) await this.updateRuntimeMetrics({ workspaceBytesHydrated: hydratedBytes });
  }

  private async unifiedWorkspaceIdentity(scope: SandboxWorkspaceScope, tenantId: string): Promise<{ scope: WorkspaceScope; branch: string }> {
    const jurisdiction = (this.env as unknown as SandboxBindings).DATA_JURISDICTION === "eu" ? "eu" : "global";
    let projectId = scope.projectId;
    if (!projectId && scope.installationId) {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(scope.installationId));
      projectId = `extension-${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 48)}`;
    }
    return {
      scope: { tenantId, spaceId: scope.spaceId, projectId: projectId ?? `space-assistant-${scope.spaceId}`, jurisdiction },
      branch: scope.branch ?? this.activeExecution?.scope.workspaceBranch ?? "main",
    };
  }

  private async workspaceCoordinatorCall(scope: WorkspaceScope, path: string, body?: unknown): Promise<Response> {
    return workspaceCoordinatorRequest(this.env as unknown as SandboxBindings, scope, path, { ...(body === undefined ? {} : { body }) });
  }

  private async requireWorkspaceResponse(response: Response): Promise<Record<string, unknown>> {
    const result = await response.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    if (!response.ok) {
      const code = typeof result.error_code === "string" ? result.error_code : `http_${response.status}`;
      throw new Error(`workspace_${code}`);
    }
    return result;
  }

  private async hydrateUnifiedWorkspace(container: ContainerRuntime, scope: SandboxWorkspaceScope): Promise<void> {
    const bindings = this.env as unknown as SandboxBindings;
    if (!bindings.SCRIPTS_R2 || !bindings.WORKSPACE_COORDINATOR || !bindings.PLATFORM_SECRET) throw new Error("workspace_coordinator_unavailable");
    const invocation = this.activeExecution?.scope ?? await this.ctx.storage.get<ContainerInvocationScope>("container_invocation_scope");
    const meter = await this.ctx.storage.get<ContainerMeter>("container_meter");
    const tenantId = invocation?.tenantId ?? meter?.tenantId;
    if (!tenantId) throw new Error("workspace_tenant_scope_required");
    const identity = await this.unifiedWorkspaceIdentity(scope, tenantId);
    // A checkpoint written by the previous allocation must be replayed against that live
    // session before cold-start replacement closes it and advances allocation generation.
    await this.replayPendingUnifiedCheckpoint(identity.scope);
    let headResponse = await this.workspaceCoordinatorCall(identity.scope, `/v1/head?branch=${encodeURIComponent(identity.branch)}`);
    if (headResponse.status === 404) {
      // Existing project workspaces must be imported by the explicit migration workflow,
      // which holds the project mutation barrier and retains rollback aliases until the
      // imported hashes and initial revision have been verified. Runtime hydration has
      // neither that barrier nor durable rollback state, so it must never elect legacy R2
      // contents as canonical on first access. Space-level bootstrap retains its legacy
      // compatibility path until it is migrated separately.
      if (scope.projectId) throw new Error("workspace_project_migration_required");
      const entries: WorkspaceEntry[] = [];
      for await (const file of this.listR2Workspace(this.workspacePrefix(scope))) {
        if (file.path.startsWith("shared/")) continue;
        const objectKey = `workspace-v1/${identity.scope.tenantId}/${identity.scope.spaceId}/${identity.scope.projectId}/${identity.scope.jurisdiction}/content/${file.hash}`;
        this.recordWorkspaceR2("writes", file.bytes.byteLength);
        const put = await bindings.SCRIPTS_R2.put(objectKey, file.bytes, { onlyIf: { etagDoesNotMatch: "*" }, customMetadata: { sha256: file.hash, size: String(file.bytes.byteLength) } });
        if (!put) {
          const existing = await this.readWorkspaceBytes(bindings.SCRIPTS_R2, objectKey);
          if (!existing || existing.hash !== file.hash) throw new Error("workspace_content_integrity_failed");
        }
        entries.push({ path: file.path, sha256: file.hash, size: file.bytes.byteLength, executable: false, objectKey });
      }
      const initialized = await this.workspaceCoordinatorCall(identity.scope, "/v1/initialize", { scope: identity.scope, branch: identity.branch, entries });
      if (!initialized.ok && initialized.status !== 409) await this.requireWorkspaceResponse(initialized);
      headResponse = await this.workspaceCoordinatorCall(identity.scope, `/v1/head?branch=${encodeURIComponent(identity.branch)}`);
    }
    const current = await this.requireWorkspaceResponse(headResponse) as { head?: WorkspaceHead };
    if (!current.head) throw new Error("workspace_head_missing");
    const runId = invocation?.runId ?? "sandbox-session";
    const runHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(runId)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const workingBranch = `runs/${runHash.slice(0, 32)}`;
    const createdBranch = await this.workspaceCoordinatorCall(identity.scope, "/v1/branch", { scope: identity.scope, sourceBranch: identity.branch, branch: workingBranch });
    if (!createdBranch.ok) await this.requireWorkspaceResponse(createdBranch);
    const branchHead = await this.requireWorkspaceResponse(await this.workspaceCoordinatorCall(identity.scope, `/v1/head?branch=${encodeURIComponent(workingBranch)}`)) as { head?: WorkspaceHead };
    const read = await this.requireWorkspaceResponse(await this.workspaceCoordinatorCall(identity.scope, `/v1/read?branch=${encodeURIComponent(workingBranch)}`)) as { entries?: WorkspaceEntry[]; head?: WorkspaceHead };
    if (!Array.isArray(read.entries) || !read.head || read.head.manifestHash !== branchHead.head?.manifestHash) throw new Error("workspace_head_changed_retry");
    const expectedHashes: Record<string, string> = {};
    let hydratedBytes = 0;
    for (const entry of read.entries) {
      if (!isSyncableWorkspacePath(entry.path) || entry.path.startsWith("shared/")) continue;
      if (!entry.objectKey.startsWith(`workspace-v1/${identity.scope.tenantId}/${identity.scope.spaceId}/${identity.scope.projectId}/${identity.scope.jurisdiction}/content/`)) throw new Error("workspace_object_scope_mismatch");
      const stored = await this.readWorkspaceBytes(bindings.SCRIPTS_R2, entry.objectKey);
      if (!stored || stored.hash !== entry.sha256 || stored.bytes.byteLength !== entry.size) throw new Error(`workspace_content_integrity_failed:${entry.path}`);
      const response = await container.getTcpPort(HARNESS_PORT).fetch(new Request("http://sandbox/workspace/write", {
        method: "POST", headers: { "content-type": "application/json", "x-avos-restore": "1" },
        body: JSON.stringify({ files_base64: { [entry.path]: bytesToBase64(stored.bytes) } }),
      }));
      if (!response.ok) throw new Error(`Workspace hydration failed (${response.status}): ${entry.path}`);
      expectedHashes[entry.path] = entry.sha256;
      hydratedBytes += stored.bytes.byteLength;
    }
    for (const grant of scope.sharedFilesystemGrants ?? []) {
      if (scope.installationScope !== "SPACE_SHARED" || !scope.installationId) throw new Error("sandbox_shared_filesystem_denied");
      const relativePrefix = grant.path.slice("/space/shared/".length);
      const sharedPrefix = `spaces/${scope.spaceId}/space-workspace/shared/${relativePrefix}`;
      for await (const { path, bytes, hash } of this.listR2Workspace(sharedPrefix)) {
        const virtualPath = `shared/${relativePrefix}${path}`;
        const response = await container.getTcpPort(HARNESS_PORT).fetch(new Request("http://sandbox/workspace/write", {
          method: "POST", headers: { "content-type": "application/json", "x-avos-restore": "1" },
          body: JSON.stringify({ files_base64: { [virtualPath]: bytesToBase64(bytes) } }),
        }));
        if (!response.ok) throw new Error(`Shared workspace hydration failed (${response.status}): ${virtualPath}`);
        expectedHashes[virtualPath] = hash;
        hydratedBytes += bytes.byteLength;
      }
    }
    const previous = await this.ctx.storage.get<Record<string, string>>("workspace_hashes") ?? {};
    const removed = Object.keys(previous).filter(path => isSyncableWorkspacePath(path) && !(path in expectedHashes));
    if (removed.length) {
      const response = await container.getTcpPort(HARNESS_PORT).fetch(new Request("http://sandbox/workspace/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paths: removed }) }));
      if (!response.ok) throw new Error(`Workspace refresh deletion failed (${response.status})`);
    }
    const generation = await this.ctx.storage.get<number>("workspace_runtime_generation") ?? 1;
    const existingSession = await this.ctx.storage.get<{ id: string; runId: string; generation: number; branch: string }>("workspace_session");
    if (!existingSession || existingSession.runId !== runId || existingSession.generation !== generation || existingSession.branch !== workingBranch) {
      if (existingSession) {
        const closed = await this.workspaceCoordinatorCall(identity.scope, "/v1/close", { sessionId: existingSession.id });
        if (!closed.ok) await this.requireWorkspaceResponse(closed);
      }
      const opened = await this.requireWorkspaceResponse(await this.workspaceCoordinatorCall(identity.scope, "/v1/open", {
        scope: identity.scope, branch: workingBranch, parentBranch: identity.branch, actorId: invocation?.actorId ?? "sandbox-runtime",
        runtimeId: `tool-sandbox:${scope.spaceId}:${scope.projectId ?? "space"}`, allocationGeneration: generation,
        mode: "checked_handoff",
      })) as { session?: { id: string; fence: number; allocationGeneration: number; branch: string } };
      if (!opened.session) throw new Error("workspace_session_missing");
      await this.ctx.storage.put("workspace_session", { ...opened.session, runId, generation, scope: identity.scope, branch: workingBranch, parentBranch: identity.branch });
    }
    await this.ctx.storage.put("workspace_scope", scope);
    await this.ctx.storage.put("workspace_hashes", expectedHashes);
    if (hydratedBytes) await this.updateRuntimeMetrics({ workspaceBytesHydrated: hydratedBytes });
  }

  private async publishWorkspaceChanges(container: ContainerRuntime, scope: SandboxWorkspaceScope, holderId: string): Promise<{ changed: number }> {
    if ((this.env as unknown as SandboxBindings).UNIFIED_WORKSPACE_ENABLED === "true" && !scope.installationId) {
      return this.publishUnifiedWorkspaceChanges(container, scope, holderId);
    }
    const invocation = this.activeExecution?.scope;
    const meter = await this.ctx.storage.get<ContainerMeter>("container_meter");
    const tenantId = invocation?.tenantId ?? meter?.tenantId;
    const spaceId = invocation?.spaceId ?? meter?.spaceId;
    if (tenantId && spaceId && !await this.tenantSpaceIsActive(tenantId, spaceId)) throw new Error("tenant_suspended");
    if (scope.projectId) {
      if (!tenantId) throw new Error("workspace_tenant_scope_required");
      const erasure = await this.requireProjectNotErased({ tenantId, spaceId: scope.spaceId, projectId: scope.projectId });
      if (erasure === "unavailable") throw new Error("workspace_erasure_check_unavailable");
      if (erasure === "erased") throw new Error("workspace_project_erased");
    }
    const bindings = this.env as unknown as SandboxBindings;
    if (!bindings.SCRIPTS_R2 || !bindings.CONCURRENCY_DO) throw new Error("Fenced workspace publication is unavailable");
    const port = container.getTcpPort(HARNESS_PORT);
    const listed = await port.fetch(new Request("http://sandbox/workspace/list", { method: "POST" }));
    if (!listed.ok) throw new Error(`Workspace listing failed (${listed.status})`);
    const listResult = await listed.json<{ files: string[] }>();
    const currentPaths = new Set(listResult.files.filter(isSyncableWorkspacePath));
    const priorHashes = (await this.ctx.storage.get<Record<string, string>>("workspace_hashes")) ?? {};
    const paths = [...new Set([...Object.keys(priorHashes), ...currentPaths])].sort();
    const changes: WorkspacePublication["changes"] = [];
    let capturedBytes = 0;
    let stagedBytes = 0;
    for (const path of paths) {
      let currentBase64: string | undefined;
      if (currentPaths.has(path)) {
        const response = await port.fetch(new Request("http://sandbox/workspace/read", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ paths: [path], encoding: "base64" }),
        }));
        if (!response.ok) throw new Error(`Workspace read failed (${response.status}): ${path}`);
        currentBase64 = (await response.json<{ files_base64: Record<string, string> }>()).files_base64[path];
        if (typeof currentBase64 !== "string") throw new Error(`Incomplete container snapshot; refusing publication: ${path}`);
        capturedBytes += Uint8Array.from(atob(currentBase64), (character) => character.charCodeAt(0)).byteLength;
      }
      const bytes = currentBase64 === undefined ? null : Uint8Array.from(atob(currentBase64), (character) => character.charCodeAt(0));
      const digest = bytes ? await crypto.subtle.digest("SHA-256", bytes) : undefined;
      const newHash = digest ? [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("") : null;
      const expectedHash = priorHashes[path] ?? null;
      if (newHash === expectedHash) continue;
      // Shared files live outside the installation's private workspace and are published
      // only through the explicit path grant below.
      if (path.startsWith("shared/")) sharedObjectKey(scope, path, "write");
      const stagedKey = bytes ? `workspace-staging/${scope.spaceId}/${scope.projectId ?? "_assistant"}/${holderId}/${newHash}` : undefined;
      if (bytes && stagedKey) {
        this.recordWorkspaceR2("writes", bytes.byteLength);
        await bindings.SCRIPTS_R2.put(stagedKey, bytes, { customMetadata: { sha256: newHash! }, onlyIf: { etagDoesNotMatch: "*" } });
        stagedBytes += bytes.byteLength;
      }
      changes.push({ path, expectedHash, newHash, ...(stagedKey ? { stagedKey } : {}) });
    }
    if (capturedBytes || stagedBytes) await this.updateRuntimeMetrics({ workspaceBytesCaptured: capturedBytes, workspaceBytesStaged: stagedBytes });
    if (!changes.length) return { changed: 0 };
    // The journal is written before the first remote publication. Recovery completes the same
    // intended revisions, including a publication whose response was lost, before hydration.
    const createdAt = new Date().toISOString();
    await this.ctx.storage.put("workspace_pending_publication", { scope, changes, createdAt } satisfies WorkspacePublication);
    const checkpointStarted = Date.now();
    try {
      await this.replayWorkspacePublication(holderId);
      await this.updateRuntimeMetrics({ workspaceCheckpoints: 1, workspaceCheckpointMs: Math.max(0, Date.now() - checkpointStarted) });
    } catch (error) {
      await this.updateRuntimeMetrics({ workspaceCheckpointFailures: 1, workspaceCheckpointFailureMs: Math.max(0, Date.now() - checkpointStarted) }).catch(() => undefined);
      await this.recordWorkspaceStagingAge(createdAt);
      throw error;
    }
    return { changed: changes.length };
  }

  private async publishUnifiedWorkspaceChanges(container: ContainerRuntime, scope: SandboxWorkspaceScope, holderId: string): Promise<{ changed: number }> {
    const invocation = this.activeExecution?.scope ?? await this.ctx.storage.get<ContainerInvocationScope>("container_invocation_scope");
    const meter = await this.ctx.storage.get<ContainerMeter>("container_meter");
    const tenantId = invocation?.tenantId ?? meter?.tenantId;
    if (!tenantId) throw new Error("workspace_tenant_scope_required");
    if (!await this.tenantSpaceIsActive(tenantId, scope.spaceId)) throw new Error("tenant_suspended");
    const identity = await this.unifiedWorkspaceIdentity(scope, tenantId);
    await this.replayPendingUnifiedCheckpoint(identity.scope);
    const port = container.getTcpPort(HARNESS_PORT);
    const listed = await port.fetch(new Request("http://sandbox/workspace/list", { method: "POST" }));
    if (!listed.ok) throw new Error(`Workspace listing failed (${listed.status})`);
    const listResult = await listed.json<{ files: string[] }>();
    const currentPaths = new Set((listResult.files ?? []).filter(isSyncableWorkspacePath).filter((path) => !path.startsWith("shared/")));
    const priorHashes = await this.ctx.storage.get<Record<string, string>>("workspace_hashes") ?? {};
    const paths = [...new Set([...Object.keys(priorHashes).filter((path) => !path.startsWith("shared/")), ...currentPaths])].sort();
    const changes: Array<{ path: string; expectedHash: string | null; contentBase64: string | null }> = [];
    let capturedBytes = 0;
    for (const path of paths) {
      let contentBase64: string | null = null;
      let newHash: string | null = null;
      if (currentPaths.has(path)) {
        const response = await port.fetch(new Request("http://sandbox/workspace/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paths: [path], encoding: "base64" }) }));
        if (!response.ok) throw new Error(`Workspace read failed (${response.status}): ${path}`);
        contentBase64 = (await response.json<{ files_base64: Record<string, string> }>()).files_base64[path] ?? null;
        if (contentBase64 === null) throw new Error(`Incomplete container snapshot; refusing publication: ${path}`);
        const bytes = Uint8Array.from(atob(contentBase64), (character) => character.charCodeAt(0));
        capturedBytes += bytes.byteLength;
        if (bytes.byteLength > 20 * 1024 * 1024) throw new Error(`workspace_file_limit_exceeded:${path}`);
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        newHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      }
      const expectedHash = priorHashes[path] ?? null;
      if (newHash !== expectedHash) changes.push({ path, expectedHash, contentBase64 });
    }
    if (capturedBytes) await this.updateRuntimeMetrics({ workspaceBytesCaptured: capturedBytes });
    if (!changes.length) return { changed: 0 };
    const runtimeSession = await this.ctx.storage.get<{ id: string; fence: number; allocationGeneration: number; scope: WorkspaceScope; branch: string; parentBranch: string }>("workspace_session");
    if (!runtimeSession || JSON.stringify(runtimeSession.scope) !== JSON.stringify(identity.scope) || runtimeSession.parentBranch !== identity.branch) throw new Error("workspace_session_missing");
    const changeSetHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(changes))))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const executionId = invocation?.executionId ?? holderId;
    const executionHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(executionId)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const idempotencyKey = `workspace-${executionHash.slice(0, 24)}-${changeSetHash.slice(0, 32)}`;
    const checkpoint = { sessionId: runtimeSession.id, allocationGeneration: runtimeSession.allocationGeneration, fence: runtimeSession.fence,
      baseRevision: (await this.requireWorkspaceResponse(await this.workspaceCoordinatorCall(identity.scope, `/v1/head?branch=${encodeURIComponent(runtimeSession.branch)}`)) as { head: WorkspaceHead }).head.revision,
      idempotencyKey, stageId: idempotencyKey, changes, workspaceScope: identity.scope, createdAt: new Date().toISOString() };
    await this.ctx.storage.put("workspace_pending_coordinator_checkpoint", checkpoint);
    await this.stageAndCheckpointUnified(identity.scope, checkpoint);
    const nextHashes = { ...priorHashes };
    for (const change of changes) {
      if (change.contentBase64 === null) delete nextHashes[change.path];
      else {
        const bytes = Uint8Array.from(atob(change.contentBase64), (character) => character.charCodeAt(0));
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        nextHashes[change.path] = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      }
    }
    await this.ctx.storage.put("workspace_hashes", nextHashes);
    await this.ctx.storage.delete("workspace_pending_coordinator_checkpoint");
    return { changed: changes.length };
  }

  private async stageAndCheckpointUnified(identity: WorkspaceScope, checkpoint: Record<string, unknown>): Promise<{ publication: { status?: string }; error_code?: string }> {
    const checkpointStarted = Date.now();
    try {
      let stagedCheckpoint = checkpoint;
      if (Array.isArray(checkpoint.changes)) {
        const stageId = typeof checkpoint.stageId === "string" ? checkpoint.stageId : String(checkpoint.idempotencyKey ?? "");
        const staged = await this.workspaceCoordinatorCall(identity, "/v1/stage", {
          sessionId: checkpoint.sessionId, allocationGeneration: checkpoint.allocationGeneration, fence: checkpoint.fence,
          stageId, changes: checkpoint.changes,
        });
        await this.requireWorkspaceResponse(staged);
        const stagedBytes = checkpoint.changes.reduce((total, change) => {
          const contentBase64 = change && typeof change === "object" ? (change as { contentBase64?: unknown }).contentBase64 : undefined;
          return total + (typeof contentBase64 === "string" ? Uint8Array.from(atob(contentBase64), (character) => character.charCodeAt(0)).byteLength : 0);
        }, 0);
        if (stagedBytes) await this.updateRuntimeMetrics({ workspaceBytesStaged: stagedBytes });
        const { changes: _changes, ...checkpointRef } = checkpoint;
        stagedCheckpoint = { ...checkpointRef, stageId };
        await this.ctx.storage.put("workspace_pending_coordinator_checkpoint", stagedCheckpoint);
      }
      const response = await this.workspaceCoordinatorCall(identity, "/v1/checkpoint", stagedCheckpoint);
      const result = await response.json<{ publication?: { status?: string }; error_code?: string }>().catch(() => ({} as { publication?: { status?: string }; error_code?: string }));
      if (!response.ok || !result.publication || !["published", "noop"].includes(result.publication.status ?? "")) {
        throw new Error(`workspace_${result.error_code ?? result.publication?.status ?? `http_${response.status}`}`);
      }
      await this.updateRuntimeMetrics({ workspaceCheckpoints: 1, workspaceCheckpointMs: Math.max(0, Date.now() - checkpointStarted) });
      await this.recordWorkspaceStagingAge(checkpoint.createdAt);
      return result as { publication: { status?: string }; error_code?: string };
    } catch (error) {
      await this.updateRuntimeMetrics({ workspaceCheckpointFailures: 1, workspaceCheckpointFailureMs: Math.max(0, Date.now() - checkpointStarted) }).catch(() => undefined);
      await this.recordWorkspaceStagingAge(checkpoint.createdAt);
      throw error;
    }
  }

  private async replayPendingUnifiedCheckpoint(identity: WorkspaceScope): Promise<void> {
    const checkpoint = await this.ctx.storage.get<Record<string, unknown>>("workspace_pending_coordinator_checkpoint");
    if (!checkpoint) return;
    if (JSON.stringify(checkpoint.workspaceScope) !== JSON.stringify(identity)) throw new Error("workspace_pending_scope_mismatch");
    await this.stageAndCheckpointUnified(identity, checkpoint);
    const runtimeSession = await this.ctx.storage.get<{ branch: string }>("workspace_session");
    if (!runtimeSession) throw new Error("workspace_session_missing");
    const replayed = await this.requireWorkspaceResponse(await this.workspaceCoordinatorCall(identity, `/v1/read?branch=${encodeURIComponent(runtimeSession.branch)}`)) as { entries?: WorkspaceEntry[] };
    if (!Array.isArray(replayed.entries)) throw new Error("workspace_recovery_manifest_missing");
    const recovered = Object.fromEntries(replayed.entries.filter(entry => !entry.path.startsWith("shared/")).map(entry => [entry.path, entry.sha256]));
    await this.ctx.storage.put("workspace_hashes", recovered);
    await this.ctx.storage.delete("workspace_pending_coordinator_checkpoint");
  }

  private async replayWorkspacePublication(holderId: string): Promise<void> {
    const publication = await this.ctx.storage.get<WorkspacePublication>("workspace_pending_publication");
    if (!publication) return;
    const bindings = this.env as unknown as SandboxBindings;
    const invocation = this.activeExecution?.scope ?? await this.ctx.storage.get<ContainerInvocationScope>("container_invocation_scope");
    const meter = await this.ctx.storage.get<ContainerMeter>("container_meter");
    const tenantId = invocation?.tenantId ?? meter?.tenantId;
    // The migration barrier is meaningful only while the coordinator path is enabled: its
    // migration routes are themselves behind the same kill switch. With rollout disabled,
    // requiring a coordinator here would make the independent legacy R2 writer unavailable.
    if (publication.scope.projectId && !publication.scope.installationId && bindings.UNIFIED_WORKSPACE_ENABLED === "true") {
      if (!tenantId) throw new Error("workspace_tenant_scope_required");
      const erasure = await this.requireProjectNotErased({ tenantId, spaceId: publication.scope.spaceId, projectId: publication.scope.projectId });
      if (erasure === "unavailable") throw new Error("workspace_erasure_check_unavailable");
      if (erasure === "erased") throw new Error("workspace_project_erased");
      if (!bindings.CONCURRENCY_DO) throw new Error("workspace_project_mutation_barrier_unavailable");
      const gateKey = `lock:${publication.scope.spaceId}:${publication.scope.projectId}:workspace-migration-barrier`;
      const gate = bindings.CONCURRENCY_DO.get(bindings.CONCURRENCY_DO.idFromName(gateKey));
      const gateHolder = `sandbox:${holderId}:${crypto.randomUUID()}`.slice(0, 128);
      const acquired = await gate.fetch(new Request("http://concurrency-do/locks/acquire", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: gateKey, holderId: gateHolder, ttlMs: 10 * 60_000 }) }));
      const lease = await acquired.json<{ acquired?: boolean; fencingToken?: number }>().catch((): { acquired?: boolean; fencingToken?: number } => ({}));
      if (!acquired.ok || !lease.acquired || !lease.fencingToken) throw new Error("workspace_project_mutation_barrier_busy");
      try {
        const identity = await this.unifiedWorkspaceIdentity(publication.scope, tenantId);
        const status = await this.workspaceCoordinatorCall(identity.scope, "/v1/migration/status");
        if (!status.ok) throw new Error("workspace_migration_status_unavailable");
        const state = await status.json<{ migration?: unknown }>();
        if (state.migration) throw new Error("workspace_legacy_migration_barrier_active");
        await this.applyWorkspacePublication(holderId);
      } finally {
        await gate.fetch(new Request("http://concurrency-do/locks/release", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: gateKey, holderId: gateHolder, fencingToken: lease.fencingToken }) })).catch(() => undefined);
      }
      return;
    }
    await this.applyWorkspacePublication(holderId);
  }

  private async applyWorkspacePublication(holderId: string): Promise<void> {
    const publication = await this.ctx.storage.get<WorkspacePublication>("workspace_pending_publication");
    if (!publication) return;
    const bindings = this.env as unknown as SandboxBindings;
    if (!bindings.SCRIPTS_R2 || !bindings.CONCURRENCY_DO) throw new Error("Fenced workspace recovery is unavailable");
    const { scope, changes } = publication;
    const nextHashes = (await this.ctx.storage.get<Record<string, string>>("workspace_hashes")) ?? {};
    for (const change of changes) {
      const { path, expectedHash, newHash, stagedKey } = change;
      const key = workspaceObjectKey(scope, path, "write");
      const current = await this.readWorkspaceBytes(bindings.SCRIPTS_R2, key);
      if ((current?.hash ?? null) === newHash) {
        if (newHash) nextHashes[path] = newHash;
        else delete nextHashes[path];
        continue;
      }
      const staged = stagedKey ? await this.readWorkspaceBytes(bindings.SCRIPTS_R2, stagedKey) : null;
      if (newHash !== null && staged?.hash !== newHash) throw new Error(`Workspace staging integrity failed: ${path}`);
      const lockKey = `lock:${scope.spaceId}:${scope.projectId ?? "_"}:workspace-file:${key}`;
      const stub = bindings.CONCURRENCY_DO.get(bindings.CONCURRENCY_DO.idFromName(lockKey));
      const acquired = await stub.fetch(new Request("http://concurrency-do/lock/acquire", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: lockKey, holderId, ttlMs: 30_000 }),
      }));
      const lease = await acquired.json<{ acquired?: boolean; fencingToken?: number }>();
      if (!acquired.ok || !lease.acquired || !lease.fencingToken) throw new Error(`Workspace lock unavailable for '${path}'`);
      try {
        const result = await stub.fetch(new Request("http://concurrency-do/workspace/publish", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: lockKey, holderId, fencingToken: lease.fencingToken, path: key,
            operation: newHash === null ? "delete" : "write", expectedHash,
            ...(staged ? { contentBase64: bytesToBase64(staged.bytes) } : {}),
            metadata: { source: "tool-sandbox", workspaceBranch: scope.branch ?? "main" },
          }),
        }));
        if (!result.ok) throw new Error(`Workspace CAS conflict for '${path}' (${result.status})`);
      } finally {
        await stub.fetch(new Request("http://concurrency-do/lock/release", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: lockKey, holderId, fencingToken: lease.fencingToken }),
        })).catch(() => undefined);
      }
      if (newHash) nextHashes[path] = newHash;
      else delete nextHashes[path];
      await this.ctx.storage.put("workspace_hashes", nextHashes);
    }
    await this.ctx.storage.put("workspace_hashes", nextHashes);
    await this.ctx.storage.delete("workspace_pending_publication");
    await this.recordWorkspaceStagingAge(publication.createdAt);
    const stagedKeys = changes.flatMap((change) => change.stagedKey ? [change.stagedKey] : []);
    if (stagedKeys.length) { this.recordWorkspaceR2("deletes"); await bindings.SCRIPTS_R2.delete(stagedKeys).catch(() => undefined); }
  }

  override async alarm(): Promise<void> {
    const pending = await this.ctx.storage.get<ContainerMeter>("container_reservation_pending");
    if (pending && pending.expiresAt <= Date.now()) {
      await finalizeWorkflowBudget(this.env as Env, pending.tenantId, pending.reservationId, "release");
      await this.ctx.storage.delete("container_reservation_pending");
    }
    const meter = await this.ctx.storage.get<ContainerMeter>("container_meter");
    const executionScope = this.activeExecution?.scope;
    const ownerTenantId = executionScope?.tenantId ?? meter?.tenantId ?? pending?.tenantId;
    const ownerSpaceId = executionScope?.spaceId ?? meter?.spaceId ?? pending?.spaceId;
    if (ownerTenantId && ownerSpaceId && !await this.tenantSpaceIsActive(ownerTenantId, ownerSpaceId)) {
      this.activeExecution?.controller.abort();
      await this.discardCheckpoint();
      // Do not snapshot or publish dirty workspace state after suspension.
      const container = this.container;
      if (container?.running) {
        if (!container.destroy) throw new Error("container_hard_stop_unsupported");
        await container.destroy();
      }
      const pendingReservation = await this.ctx.storage.get<ContainerMeter>("container_reservation_pending");
      if (pendingReservation) {
        await finalizeWorkflowBudget(this.env as Env, pendingReservation.tenantId, pendingReservation.reservationId, "release");
        await this.ctx.storage.delete("container_reservation_pending");
      }
      await this.settleMeter();
      await this.ctx.storage.delete("sidecar_warm_expires_at");
      await this.ctx.storage.put("container_status", "hibernated");
      return;
    }
    const storedInvocation = executionScope ?? await this.ctx.storage.get<ContainerInvocationScope>("container_invocation_scope");
    if (storedInvocation?.projectId) {
      const erasure = await this.requireProjectNotErased(storedInvocation);
      if (erasure !== "active") {
        if (erasure === "unavailable") {
          this.activeExecution?.controller.abort();
          const container = this.container;
          if (container?.running) {
            if (!container.destroy) throw new Error("container_hard_stop_unsupported");
            await container.destroy();
          }
          await this.settleMeter();
          await this.ctx.storage.put("container_status", "hibernated");
        }
        await this.ctx.storage.setAlarm(Date.now() + 1000);
        return;
      }
    }
    if (meter?.endedAt !== undefined || meter && meter.expiresAt <= Date.now()) {
      this.activeExecution?.controller.abort();
      await this.stopContainer(); return;
    }
    const active = this.activeExecution;
    if (active) {
      const profile = await this.packageEgressProfile(active.scope);
      const configuredProfile = await this.ctx.storage.get<ContainerEgressProfile>("container_egress_profile");
      if (this.activeExecution !== active) { await this.ctx.storage.setAlarm(Date.now() + 1000); return; }
      if (profile !== configuredProfile) {
        active.controller.abort();
        await this.discardCheckpoint();
        const container = this.container;
        if (container?.running) {
          if (!container.destroy) throw new Error("container_hard_stop_unsupported");
          await container.destroy();
        }
        await this.ctx.storage.delete("sidecar_warm_expires_at");
        await this.ctx.storage.put("container_status", "hibernated");
        await this.ctx.storage.setAlarm(Date.now() + 1000);
        return;
      }
      await this.ctx.storage.setAlarm(Math.min(Date.now() + 1000, active.scope.deadline));
      return;
    }
    // Idle publication/checkpoint/destruction must not race a newly arriving execution.
    // Active-run alarms above remain outside the queue so they can interrupt hung work.
    const idle = this.executionQueue.then(() => this.idleAlarm());
    this.executionQueue = idle.then(() => undefined, () => undefined);
    await idle;
  }

  private async idleAlarm(): Promise<void> {
    const meter = await this.ctx.storage.get<ContainerMeter>("container_meter");
    const sidecarExpiresAt = await this.ctx.storage.get<number>("sidecar_warm_expires_at");
    if (sidecarExpiresAt !== undefined && sidecarExpiresAt <= Date.now()) {
      await this.stopContainer(true);
      return;
    }
    const lastUsed =
      (await this.ctx.storage.get<number>("last_used_at")) ?? this.lastUsedAt;
    const taskActive = (await this.ctx.storage.get<boolean>("task_active")) === true;
    const idleWindow = sidecarExpiresAt !== undefined ? SIDECAR_WARM_LEASE_MS : taskActive ? ACTIVE_TASK_IDLE_WINDOW_MS : BASE_IDLE_WINDOW_MS;
    if (Date.now() - lastUsed >= idleWindow) {
      const container = this.container;
      if (container?.running) {
        const port = container.getTcpPort(HARNESS_PORT);
        const scope = await this.ctx.storage.get<SandboxWorkspaceScope>("workspace_scope");
        if (scope && (this.env as unknown as SandboxBindings).SCRIPTS_R2) {
          await this.replayWorkspacePublication(crypto.randomUUID());
          await this.publishWorkspaceChanges(container, scope, crypto.randomUUID());
        } else {
          const snapshot: { files?: Record<string, string> } = await port.fetch(new Request("http://sandbox/workspace/read", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).then((r) => r.json<{ files?: Record<string, string> }>()).catch(() => ({}));
          if (snapshot.files) await this.ctx.storage.put("workspace_snapshot", snapshot.files);
        }
        await this.stopContainer(true);
      }
      else await this.settleMeter();
      await this.ctx.storage.put("container_status", "hibernated");
    } else {
      await this.ctx.storage.setAlarm(Math.min(lastUsed + idleWindow, meter?.expiresAt ?? Infinity));
    }
  }

  private async handleRequest(request: Request): Promise<Response> {
    if (request.signal.aborted) throw new Error("container_cancelled");
    if (new URL(request.url).pathname === "/_internal/artifact-transfer" && request.method === "POST")
      return this.transferInstallationArtifact(request);
    const scopeHeader = request.headers.get("x-naelao-container-scope");
    if (scopeHeader) {
      const scope = JSON.parse(scopeHeader) as ContainerInvocationScope;
      if (!await this.tenantSpaceIsActive(scope.tenantId, scope.spaceId)) return Response.json({ ok: false, error: "tenant_suspended" }, { status: 403 });
      const erasure = await this.requireProjectNotErased(scope);
      if (erasure === "erased") return Response.json({ ok: false, error: "workspace_project_erased" }, { status: 410 });
      if (erasure === "unavailable") return Response.json({ ok: false, error: "workspace_erasure_check_unavailable" }, { status: 503 });
    }
    const url = new URL(request.url);
    let execScope: SandboxWorkspaceScope | undefined;
    if ((url.pathname === "/exec" || WORKSPACE_ROUTES.includes(url.pathname)) && request.method === "POST") {
      const body = await request.clone().json<{ spaceId?: string; projectId?: string; workspaceBranch?: string }>().catch((): { spaceId?: string; projectId?: string; workspaceBranch?: string } => ({}));
      const containerScope = JSON.parse(request.headers.get("x-naelao-container-scope") ?? "null") as ContainerInvocationScope | null;
      if (!containerScope || body.spaceId !== undefined && body.spaceId !== containerScope.spaceId
        || body.projectId !== undefined && body.projectId !== containerScope.projectId
        || body.workspaceBranch !== containerScope.workspaceBranch)
        return Response.json({ ok: false, error: "sandbox_workspace_identity_mismatch" }, { status: 403 });
      execScope = {
        spaceId: containerScope.spaceId,
        ...(containerScope.projectId ? { projectId: containerScope.projectId } : {}),
        ...(containerScope?.installationId ? { installationId: containerScope.installationId } : {}),
        ...(containerScope?.installationScope ? { installationScope: containerScope.installationScope } : {}),
        ...(containerScope?.sharedFilesystemGrants?.length ? { sharedFilesystemGrants: containerScope.sharedFilesystemGrants } : {}),
        ...(body.workspaceBranch ? { branch: body.workspaceBranch } : {}),
      };
    } else if (url.pathname === "/pdf/render" && request.method === "POST") {
      const body = await request.clone().json<{ spaceId?: string; projectId?: string | null }>()
        .catch((): { spaceId?: string; projectId?: string | null } => ({}));
      const containerScope = JSON.parse(request.headers.get("x-naelao-container-scope") ?? "null") as ContainerInvocationScope | null;
      if (!containerScope || body.spaceId !== containerScope.spaceId || (body.projectId ?? undefined) !== containerScope.projectId) {
        return Response.json({ ok: false, error: "sandbox_workspace_identity_mismatch" }, { status: 403 });
      }
    } else if (url.pathname === "/media/extract-audio" && request.method === "POST") {
      const body = await request.clone().json<{ tenantId?: string; spaceId?: string; projectId?: string | null; taskId?: string }>()
        .catch((): { tenantId?: string; spaceId?: string; projectId?: string | null; taskId?: string } => ({}));
      const containerScope = JSON.parse(request.headers.get("x-naelao-container-scope") ?? "null") as ContainerInvocationScope | null;
      if (!containerScope || body.tenantId !== containerScope.tenantId || body.spaceId !== containerScope.spaceId
        || (body.projectId ?? undefined) !== containerScope.projectId || body.taskId !== containerScope.runId
        || containerScope.actorId !== "attachment-reader") {
        return Response.json({ ok: false, error: "sandbox_media_identity_mismatch" }, { status: 403 });
      }
    }
    const storedScope = await this.ctx.storage.get<SandboxWorkspaceScope>("workspace_scope");
    if (!execScope) execScope = storedScope;
    if (execScope) {
      try { this.workspacePrefix(execScope); }
      catch (error) { return Response.json({ ok: false, error: String(error) }, { status: 400 }); }
      const bindings = this.env as unknown as SandboxBindings;
      if (!bindings.SCRIPTS_R2 || !bindings.CONCURRENCY_DO) return Response.json({ ok: false, error: "Fenced workspace persistence is unavailable" }, { status: 503 });
      if (storedScope && JSON.stringify(storedScope) !== JSON.stringify(execScope)) return Response.json({ ok: false, error: "sandbox_workspace_scope_mismatch" }, { status: 409 });
      await this.replayWorkspacePublication(crypto.randomUUID());
    }
    this.lastUsedAt = Date.now();
    await this.ctx.storage.put("last_used_at", this.lastUsedAt);
    if (request.headers.get("x-avos-task-active") === "1") {
      await this.ctx.storage.put("task_active", true);
    }

    if (url.pathname === "/lifecycle" && request.method === "POST") {
      let scope: ContainerInvocationScope;
      try { scope = await this.authenticatedScope(request); }
      catch { return Response.json({ ok: false, error: "container_scope_denied" }, { status: 403 }); }
      const body = await request.json<{ status?: "active" | "blocked" | "completed" | "failed" | "cancelled" | "suspended" | "indeterminate"; tenantId?: string; spaceId?: string;
        projectId?: string; workspaceBranch?: string }>().catch((): { status?: "active" | "blocked" | "completed" | "failed" | "cancelled" | "suspended" | "indeterminate"; tenantId?: string;
          spaceId?: string; projectId?: string; workspaceBranch?: string } => ({}));
      if (body.tenantId !== scope.tenantId || body.spaceId !== scope.spaceId || body.projectId !== scope.projectId
        || body.workspaceBranch !== scope.workspaceBranch) {
        return Response.json({ ok: false, error: "sandbox_workspace_identity_mismatch" }, { status: 403 });
      }
      const workspaceScope: SandboxWorkspaceScope = { spaceId: scope.spaceId, ...(scope.projectId ? { projectId: scope.projectId } : {}),
        ...(scope.workspaceBranch ? { branch: scope.workspaceBranch } : {}), ...(scope.installationId ? { installationId: scope.installationId } : {}),
        ...(scope.installationScope ? { installationScope: scope.installationScope } : {}),
        ...(scope.sharedFilesystemGrants?.length ? { sharedFilesystemGrants: scope.sharedFilesystemGrants } : {}) };
      try { this.workspacePrefix(workspaceScope); }
      catch { return Response.json({ ok: false, error: "invalid workspace scope" }, { status: 400 }); }
      const storedScope = await this.ctx.storage.get<SandboxWorkspaceScope>("workspace_scope");
      if (storedScope && (storedScope.spaceId !== workspaceScope.spaceId || storedScope.projectId !== workspaceScope.projectId
        || storedScope.branch !== workspaceScope.branch)) return Response.json({ ok: false, error: "sandbox_workspace_scope_mismatch" }, { status: 409 });
      if ((this.env as unknown as SandboxBindings).UNIFIED_WORKSPACE_ENABLED === "true" && !scope.installationId
        && (body.status === "blocked" || body.status === "completed")) {
        const session = await this.ctx.storage.get<{ id: string; fence: number; allocationGeneration: number; branch: string; parentBranch: string; runId: string }>("workspace_session");
        if (session) {
          try {
            const container = this.container;
            if (container?.running) await this.publishUnifiedWorkspaceChanges(container, workspaceScope, crypto.randomUUID());
            if (body.status === "completed") {
              const generation = await this.ctx.storage.get<number>("workspace_runtime_generation") ?? session.allocationGeneration;
              const targetBranch = session.parentBranch;
              if (!targetBranch) throw new Error("workspace_merge_target_missing");
              const runHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(session.runId)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
              const merged = await this.workspaceCoordinatorCall(await this.unifiedWorkspaceIdentity(workspaceScope, scope.tenantId).then((value) => value.scope), "/v1/merge", {
                sessionId: session.id, targetBranch, allocationGeneration: generation, fence: session.fence,
                idempotencyKey: `run-merge-${runHash.slice(0, 40)}`,
              });
              const mergeResult = await merged.json<{ publication?: { status?: string; conflicts?: unknown[] }; error_code?: string }>().catch(() => ({} as { publication?: { status?: string; conflicts?: unknown[] }; error_code?: string }));
              if (!merged.ok || !mergeResult.publication || !["published", "noop"].includes(mergeResult.publication.status ?? "")) {
                return Response.json({ ok: false, error: `workspace_${mergeResult.error_code ?? mergeResult.publication?.status ?? `http_${merged.status}`}`, conflicts: mergeResult.publication?.conflicts ?? [], working_branch: session.branch }, { status: 409 });
              }
            }
          } catch (error) {
            return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error), working_branch: session.branch }, { status: 409 });
          }
        }
      }
      if (body.status === "active") await this.ctx.storage.put("task_active", true);
      else if (["blocked", "completed", "failed", "cancelled", "suspended", "indeterminate"].includes(body.status ?? "")) await this.ctx.storage.delete("task_active");
      else return Response.json({ error: "status must be active or a recognized terminal state" }, { status: 400 });
      const idleWindow = body.status === "active" ? ACTIVE_TASK_IDLE_WINDOW_MS : BASE_IDLE_WINDOW_MS;
      const meter = await this.ctx.storage.get<ContainerMeter>("container_meter");
      await this.ctx.storage.setAlarm(Math.min(this.lastUsedAt + idleWindow, meter?.expiresAt ?? Infinity));
      return Response.json({ ok: true, status: body.status, idle_window_ms: idleWindow });
    }

    const taskActive = (await this.ctx.storage.get<boolean>("task_active")) === true;
    const meter = await this.ctx.storage.get<ContainerMeter>("container_meter");
    await this.ctx.storage.setAlarm(Math.min(this.lastUsedAt + (taskActive ? ACTIVE_TASK_IDLE_WINDOW_MS : BASE_IDLE_WINDOW_MS), meter?.expiresAt ?? Infinity));

    if (url.pathname === "/session/state" && request.method === "POST") {
      const stored = await this.ctx.storage.get<StoredShellState>(
        "shell_state"
      );
      const base = stored ?? { cwd: "/workspace", env: {}, gitHead: "main", revision: 1 };
      const current: StoredShellState = { ...base, stateHash: stored?.stateHash ?? await hashState(base) };
      const body: {
        expected_revision?: number;
        expected_hash?: string;
        patch?: Partial<StoredShellState>;
      } = await request
        .json<{
          expected_revision?: number;
          expected_hash?: string;
          patch?: Partial<StoredShellState>;
        }>()
        .catch(() => ({}));
      if ((
        body.expected_revision !== undefined &&
        body.expected_revision !== current.revision
      ) || (
        body.expected_hash !== undefined && body.expected_hash !== current.stateHash
      )) {
        return Response.json(
          { error: "workspace_state_conflict", revision: current.revision, state_hash: current.stateHash },
          { status: 409 }
        );
      }
      if (!body.patch) return Response.json(current);
      const withoutHash = {
        ...current,
        stateHash: undefined,
        ...(body.patch ?? {}),
        env: { ...current.env, ...(body.patch?.env ?? {}) },
        revision: current.revision + 1,
      };
      delete (withoutHash as { stateHash?: string }).stateHash;
      const next: StoredShellState = { ...withoutHash, stateHash: await hashState(withoutHash) };
      await this.ctx.storage.put("shell_state", next);
      return Response.json(next);
    }

    if (url.pathname === "/workspace/state-sync" && request.method === "POST") {
      type SyncBody = { files?: Record<string, { content: string; expected_hash?: string | null }>; deleted?: Record<string, string> };
      let scope: ContainerInvocationScope;
      try { scope = await this.authenticatedScope(request); }
      catch { return Response.json({ error: "container_scope_denied" }, { status: 403 }); }
      const body = await request.json<SyncBody & { tenantId?: string; spaceId?: string; projectId?: string; workspaceBranch?: string }>()
        .catch((): SyncBody & { tenantId?: string; spaceId?: string; projectId?: string; workspaceBranch?: string } => ({}));
      if (body.tenantId !== scope.tenantId || body.spaceId !== scope.spaceId || body.projectId !== scope.projectId
        || body.workspaceBranch !== scope.workspaceBranch)
        return Response.json({ error: "sandbox_workspace_identity_mismatch" }, { status: 403 });
      const storedScope = await this.ctx.storage.get<SandboxWorkspaceScope>("workspace_scope");
      if (storedScope && (storedScope.spaceId !== scope.spaceId || storedScope.projectId !== scope.projectId
        || storedScope.installationId !== scope.installationId || storedScope.installationScope !== scope.installationScope
        || storedScope.branch !== scope.workspaceBranch)) return Response.json({ error: "sandbox_workspace_scope_mismatch" }, { status: 409 });
      if (!body.files || typeof body.files !== "object" || Array.isArray(body.files)
        || body.deleted !== undefined && (!body.deleted || typeof body.deleted !== "object" || Array.isArray(body.deleted)))
        return Response.json({ error: "workspace_payload_invalid" }, { status: 400 });
      const entries = Object.entries(body.files);
      const deletions = Object.entries(body.deleted ?? {});
      if (entries.length + deletions.length > 300) return Response.json({ error: "workspace_file_limit_exceeded" }, { status: 413 });
      let totalBytes = 0;
      for (const [path, change] of entries) {
        if (!isPortableWorkspacePath(path) || !change || typeof change !== "object" || typeof change.content !== "string"
          || !Object.hasOwn(change, "expected_hash") || change.expected_hash !== null && (typeof change.expected_hash !== "string" || !/^[a-f0-9]{64}$/.test(change.expected_hash)))
          return Response.json({ error: "workspace_file_invalid" }, { status: 400 });
        const size = new TextEncoder().encode(change.content).byteLength;
        if (size > MAX_WORKSPACE_FILE_BYTES || (totalBytes += size) > MAX_WORKSPACE_BATCH_BYTES) return Response.json({ error: "workspace_size_limit_exceeded" }, { status: 413 });
      }
      for (const [path, expected] of deletions) if (!isPortableWorkspacePath(path) || !/^[a-f0-9]{64}$/.test(expected))
        return Response.json({ error: "workspace_delete_invalid" }, { status: 400 });
      const records = (await this.ctx.storage.get<Record<string, WorkspaceRecord>>("workspace_files")) ?? {};
      const conflicts: string[] = [];
      for (const [path, change] of entries) {
        const actual = records[path]?.hash ?? null;
        if (change.expected_hash !== undefined && change.expected_hash !== actual) conflicts.push(path);
      }
      for (const [path, expected] of deletions)
        if (records[path]?.hash !== expected) conflicts.push(path);
      if (conflicts.length) return Response.json({ error: "workspace_state_conflict", conflicts }, { status: 409 });
      let lockfilesChanged = false;
      for (const [path, change] of entries) {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(change.content));
        const hash = [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, "0")).join("");
        if (records[path]?.hash !== hash && (path === "package.json" || path === "package-lock.json")) lockfilesChanged = true;
        records[path] = { content: change.content, hash };
      }
      for (const [path] of deletions) delete records[path];
      await this.ctx.storage.put("workspace_files", records);
      return Response.json({ ok: true, hashes: Object.fromEntries(Object.entries(records).map(([path, value]) => [path, value.hash])), rehydrate: lockfilesChanged });
    }

    if (url.pathname === "/workspace/rehydrate" && request.method === "POST") {
      const body = await request.json<{ lockfiles?: Record<string, string> }>().catch((): { lockfiles?: Record<string, string> } => ({}));
      const lockfiles = body.lockfiles ?? {};
      const names = Object.keys(lockfiles);
      if (names.some(name => name !== "package.json" && name !== "package-lock.json") || typeof lockfiles["package-lock.json"] !== "string") {
        return Response.json({ error: "package-lock.json_required" }, { status: 400 });
      }
      await this.ctx.storage.put("dependency_lockfiles", lockfiles);
      const container = this.container;
      if (!container) return Response.json({ error: "Tier-6 container runtime not available" }, { status: 503 });
      // Dependencies must already be available from an approved mirror/cache. Lockfiles do
      // not authorize Internet or install scripts. No cold allocation outside a reservation.
      if (!container.running) return Response.json({ ok: false, error: "container_prewarm_required" }, { status: 409 });
      await container.getTcpPort(HARNESS_PORT).fetch(new Request("http://sandbox/workspace/write", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ files: lockfiles }),
      }));
      return container.getTcpPort(HARNESS_PORT).fetch(new Request("http://sandbox/workspace/rehydrate", {
        method: "POST", headers: request.headers, body: "{}", signal: request.signal,
      }));
    }

    const container = this.container;
    if (!container) {
      // No container runtime bound (e.g. local dev without containers). Both build/test and
      // workspace ops report the same honest "not available" — no simulated success.
      if (WORKSPACE_ROUTES.some((r) => url.pathname.endsWith(r))) {
        return Response.json(
          { ok: false, error: "Tier-6 container runtime not available" },
          { status: 503 }
        );
      }
      return Response.json(
        {
          built: false,
          tests_passed: false,
          logs: "Tier-6 container runtime not available",
        },
        { status: 503 }
      );
    }

    // Allocate only reserved capacity. Hydration follows image verification, on both cold
    // and warm execution: another runtime may have published project files since the last run.
    const coldStart = !container.running;
    if (coldStart) {
      const startupStartedAt = Date.now();
      if (request.signal.aborted) throw new Error("container_cancelled");
      if (!await this.ctx.storage.get("container_meter")) return Response.json({ ok: false, error: "container_capacity_reservation_required" }, { status: 403 });
      if (!container.destroy) return Response.json({ ok: false, error: "container_hard_stop_unsupported" }, { status: 503 });
      const meter = (await this.ctx.storage.get<ContainerMeter>("container_meter"))!;
      await this.ctx.storage.put("container_meter", { ...meter, allocatedAt: Date.now() });
      const startScope = JSON.parse(request.headers.get("x-naelao-container-scope") ?? "null") as ContainerInvocationScope | null;
      const egressProfile = startScope ? await this.packageEgressProfile(startScope) : "disabled";
      if (egressProfile === "trusted-package-hosts") {
        // General internet remains disabled. Only a non-air-gapped Space receives the
        // deployment's exact package-host interceptions.
        if (!container.interceptOutboundHttps) return Response.json({ ok: false, error: "package_egress_interception_unavailable" }, { status: 503 });
        const exports = (this.ctx as unknown as { exports?: { PackageEgress?: (options: { props: Record<string, never> }) => ContainerPort } }).exports;
        const packageEgress = exports?.PackageEgress?.({ props: {} });
        if (!packageEgress) return Response.json({ ok: false, error: "package_egress_binding_unavailable" }, { status: 503 });
        for (const host of TRUSTED_PACKAGE_HOSTS) await container.interceptOutboundHttps(host, packageEgress);
      }
      // Marketplace sidecars are immutable deployment-approved digests implementing the same
      // harness protocol. Select only the authenticated installation's pin; never accept an
      // image from the execution body or model-generated command.
      await this.ctx.storage.put("container_egress_profile", egressProfile);
      const reservedMainGeneration = startScope ? await this.reserveProjectMainGeneration(startScope, request) : undefined;
      await this.startContainer(container, startScope);
      if (reservedMainGeneration === undefined) {
        const allocationGeneration = (await this.ctx.storage.get<number>("workspace_runtime_generation") ?? 0) + 1;
        await this.ctx.storage.put("workspace_runtime_generation", allocationGeneration);
      }
      const token = await this.ctx.storage.get<string>("container_control_token") ?? Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, "0")).join("");
      await this.ctx.storage.put("container_control_token", token);
      const readyDeadline = Math.min(Date.now() + 20000, Number(JSON.parse(request.headers.get("x-naelao-container-scope") ?? "{}").deadline) || Date.now() + 20000);
      let ready = false;
      while (!ready && Date.now() < readyDeadline && !request.signal.aborted) {
        try {
          const initialized = await container.getTcpPort(HARNESS_PORT).fetch(new Request("http://sandbox/control/init", { method: "POST", signal: request.signal }));
          ready = initialized.ok;
        } catch { /* start() returns before TCP readiness; bounded readiness retry is safe */ }
        if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!ready || request.signal.aborted) throw new Error("container_startup_interrupted");
      await this.ctx.storage.put("container_status", "running");
      await this.updateRuntimeMetrics({ coldStarts: 1, startupMs: Date.now() - startupStartedAt }, Boolean(startScope?.installationId));
    }

    if (request.signal.aborted) throw new Error("container_cancelled");
    const requestedScope = JSON.parse(request.headers.get("x-naelao-container-scope") ?? "null") as ContainerInvocationScope | null;
    await this.verifyContainer(container, requestedScope);
    if (requestedScope) {
      try { await this.activateProjectMainGeneration(requestedScope, request); }
      catch (error) {
        if (this.isProjectMainRuntimeScope(requestedScope, request)) await this.stopContainer().catch(() => undefined);
        throw error;
      }
    }
    if (requestedScope?.image) {
      // Installed sidecars are installation-scoped across worker runs. The Durable Object
      // name is also scope/branch-bound; keep this persisted guard aligned with that identity
      // instead of rejecting a legitimate continuation because runId changed.
      const installedOwner = JSON.stringify([requestedScope.tenantId, requestedScope.spaceId, requestedScope.projectId,
        requestedScope.installationId, requestedScope.installationScope, requestedScope.workspaceBranch, requestedScope.image]);
      const previousOwner = await this.ctx.storage.get<string>("sidecar_owner");
      if (previousOwner && previousOwner !== installedOwner) throw new Error("container_sidecar_scope_mismatch");
      await this.ctx.storage.put("sidecar_owner", installedOwner);
    }
    if (url.pathname === "/prewarm") {
      // Capacity/readiness only. No command, script, hydration write or business mutation.
      await this.ctx.storage.delete("task_active");
      const leaseMs = requestedScope?.installationId ? SIDECAR_WARM_LEASE_MS : BASE_IDLE_WINDOW_MS;
      if (requestedScope?.installationId) await this.ctx.storage.put("sidecar_warm_expires_at", Date.now() + leaseMs);
      await this.ctx.storage.setAlarm(Math.min(Date.now() + leaseMs, (await this.ctx.storage.get<ContainerMeter>("container_meter"))!.expiresAt));
      return Response.json({ ok: true, result: { status: "warm", expires_in_ms: leaseMs, mutation_executed: false } });
    }

    if (url.pathname !== "/prewarm" && execScope && (this.env as unknown as SandboxBindings).SCRIPTS_R2) {
      const currentScope = await this.ctx.storage.get<SandboxWorkspaceScope>("workspace_scope");
      if (coldStart || !currentScope || url.pathname === "/exec" || WORKSPACE_ROUTES.includes(url.pathname)) await this.hydrateWorkspace(container, execScope);
    } else if (url.pathname !== "/prewarm" && coldStart) {
      const snapshot = await this.ctx.storage.get<Record<string, string>>("workspace_snapshot");
      if (snapshot && Object.keys(snapshot).length) {
        await container.getTcpPort(HARNESS_PORT).fetch(new Request("http://sandbox/workspace/write", {
          method: "POST", headers: { "content-type": "application/json", "x-avos-restore": "1" }, body: JSON.stringify({ files: snapshot }),
        }));
      }
    }

    if (url.pathname === "/shell" && request.method === "POST") {
      const body: { command?: string; expected_state_hash?: string } = await request.json<{ command?: string; expected_state_hash?: string }>().catch(() => ({}));
      const stored = await this.ctx.storage.get<StoredShellState>("shell_state");
      const base = stored ?? { cwd: "/workspace", env: {}, gitHead: "main", revision: 1 };
      const state: StoredShellState = { ...base, stateHash: stored?.stateHash ?? await hashState(base) };
      if (body.expected_state_hash && body.expected_state_hash !== state.stateHash)
        return Response.json({ error: "workspace_state_conflict", state_hash: state.stateHash }, { status: 409 });
      const response = await container.getTcpPort(HARNESS_PORT).fetch(new Request("http://sandbox/shell", {
        method: "POST", headers: request.headers, body: JSON.stringify({ command: body.command, session: state }), signal: request.signal,
      }));
      const result = await response.json<{ session?: { cwd: string; env: Record<string, string> } }>();
      if (response.ok && result.session) {
        const nextBase = { cwd: result.session.cwd, env: result.session.env, gitHead: state.gitHead, revision: state.revision + 1 };
        await this.ctx.storage.put("shell_state", { ...nextBase, stateHash: await hashState(nextBase) });
      }
      if (execScope) await this.publishWorkspaceChanges(container, execScope, crypto.randomUUID());
      return Response.json(result, { status: response.status });
    }

    if (url.pathname === "/workspace/write" && request.method === "POST") {
      const body = await request.json<{ files?: Record<string, string>; expected_hashes?: Record<string, string | null> }>().catch(
        () => ({}) as { files?: Record<string, string>; expected_hashes?: Record<string, string | null> }
      );
      const files = body.files;
      const expected = body.expected_hashes;
      const restoring = request.headers.get("x-avos-restore") === "1";
      if (!files || typeof files !== "object" || Array.isArray(files))
        return Response.json({ error: "workspace_files_invalid" }, { status: 400 });
      const entries = Object.entries(files);
      if (entries.length > 300) return Response.json({ error: "workspace_file_limit_exceeded" }, { status: 413 });
      let totalBytes = 0;
      for (const [path, content] of entries) {
        if (!isPortableWorkspacePath(path) || typeof content !== "string") return Response.json({ error: "workspace_file_invalid" }, { status: 400 });
        const size = new TextEncoder().encode(content).byteLength;
        if (size > MAX_WORKSPACE_FILE_BYTES || (totalBytes += size) > MAX_WORKSPACE_BATCH_BYTES) return Response.json({ error: "workspace_size_limit_exceeded" }, { status: 413 });
      }
      const records = (await this.ctx.storage.get<Record<string, WorkspaceRecord>>("workspace_files")) ?? {};
      if (!restoring) {
        if (!expected || Object.keys(files).some(path => !Object.prototype.hasOwnProperty.call(expected, path))) {
          return Response.json({ error: "workspace_hash_required", message: "expected_hashes are required for every workspace write" }, { status: 400 });
        }
        const conflicts: string[] = [];
        const nextRecords = { ...records };
        for (const [path, content] of entries) {
          const actual = execScope ? (await this.ctx.storage.get<Record<string, string>>("workspace_hashes"))?.[path] ?? null : records[path]?.hash ?? null;
          if (expected[path] !== actual) conflicts.push(path);
          const nextHash = await hashWorkspaceContent(content);
          nextRecords[path] = { content, hash: nextHash };
        }
        if (conflicts.length) return Response.json({ error: "workspace_state_conflict", conflicts }, { status: 409 });
        await this.ctx.storage.put("workspace_files", nextRecords);
      }
      const forwarded = new Request(request, { body: JSON.stringify({ files }), headers: request.headers });
      const response = await container.getTcpPort(HARNESS_PORT).fetch(forwarded);
      if (response.ok && execScope) await this.publishWorkspaceChanges(container, execScope, crypto.randomUUID());
      return response;
    }

    if (url.pathname === "/workspace/delete") {
      const body = await request.clone().json<{ paths?: string[]; expected_hashes?: Record<string, string | null> }>();
      if (!Array.isArray(body.paths) || body.paths.some(path => typeof path !== "string" || !isPortableWorkspacePath(path)))
        return Response.json({ ok: false, error: "workspace_paths_invalid" }, { status: 400 });
      const actual = await this.ctx.storage.get<Record<string, string>>("workspace_hashes") ?? {};
      if (!body.expected_hashes || body.paths.some(path => !Object.hasOwn(body.expected_hashes!, path)))
        return Response.json({ ok: false, error: "workspace_hash_required" }, { status: 400 });
      if (body.paths.some(path => body.expected_hashes![path] !== (actual[path] ?? null)))
        return Response.json({ ok: false, error: "workspace_state_conflict" }, { status: 409 });
    }

    // /build and the remaining /workspace/* routes forward to the harness. Tier-6 execution
    // hydrates from canonical R2 on a cold workspace and publishes each changed file through the
    // same fenced CAS gateway used by the other workspace writers before returning to the agent.
    const response = await container.getTcpPort(HARNESS_PORT).fetch(request);
    // A harness response marked tainted means a guest process may still be alive. Preserve the
    // marker for executeScoped() so it destroys the container, and never publish its workspace.
    if (response.headers.get("x-naelao-container-tainted") === "1") return response;
    if ((url.pathname === "/exec" || url.pathname === "/workspace/delete" && response.ok) && execScope && (this.env as unknown as SandboxBindings).SCRIPTS_R2) {
      try {
        const workspace_sync = await this.publishWorkspaceChanges(container, execScope, crypto.randomUUID());
        const body = await response.clone().json<Record<string, unknown>>().catch(() => ({}));
        return Response.json({ ...body, workspace_sync }, { status: response.status });
      } catch (error) {
        return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error), execution_response_status: response.status }, { status: 409 });
      }
    }
    return response;
  }

  private async transferInstallationArtifact(request: Request): Promise<Response> {
    let scope: ContainerInvocationScope;
    try { scope = await this.authenticatedScope(request); }
    catch { return Response.json({ error_code: "container_scope_denied" }, { status: 403 }); }
    if (!scope.installationId || !scope.image) return Response.json({ error_code: "container_installation_required" }, { status: 403 });
    const owner = JSON.stringify([scope.tenantId, scope.spaceId, scope.projectId, scope.installationId,
      scope.installationScope, scope.workspaceBranch, scope.image]);
    const previousOwner = await this.ctx.storage.get<string>("sidecar_owner");
    if (previousOwner && previousOwner !== owner) return Response.json({ error_code: "container_sidecar_scope_mismatch" }, { status: 409 });
    await this.ctx.storage.put("sidecar_owner", owner);
    if (!await this.tenantSpaceIsActive(scope.tenantId, scope.spaceId)) return Response.json({ error_code: "tenant_suspended" }, { status: 403 });
    const erasure = await this.projectErasureState(scope);
    if (erasure === "unavailable") return Response.json({ error_code: "workspace_erasure_check_unavailable" }, { status: 503 });
    if (erasure === "erased") return Response.json({ error_code: "workspace_project_erased" }, { status: 410 });
    let body: { direction?: string; path?: string; requestId?: string; digest?: string; expectedHash?: string | null };
    try { body = await request.json<typeof body>(); }
    catch { return Response.json({ error_code: "artifact_transfer_request_invalid" }, { status: 400 }); }
    const direction = body.direction;
    const path = body.path;
    const requestId = body.requestId;
    const digest = body.digest;
    const expectedHash = body.expectedHash;
    if ((direction !== "import" && direction !== "export") || typeof path !== "string" || !isSyncableWorkspacePath(path)
      || path.startsWith("shared/") || typeof requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(requestId)
      || direction === "import" && (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)
        || !(expectedHash === null || typeof expectedHash === "string" && /^[a-f0-9]{64}$/.test(expectedHash)))) {
      return Response.json({ error_code: "artifact_transfer_request_invalid" }, { status: 400 });
    }
    const bindings = this.env as unknown as SandboxBindings;
    if (!bindings.SCRIPTS_R2) return Response.json({ error_code: "artifact_transfer_store_unavailable" }, { status: 503 });
    let privatePrefix: string;
    try { privatePrefix = this.workspacePrefix({ spaceId: scope.spaceId, ...(scope.projectId ? { projectId: scope.projectId } : {}),
      installationId: scope.installationId, ...(scope.installationScope ? { installationScope: scope.installationScope } : {}),
      ...(scope.workspaceBranch ? { branch: scope.workspaceBranch } : {}) }); }
    catch { return Response.json({ error_code: "artifact_transfer_scope_invalid" }, { status: 400 }); }
    const requestHash = await hashWorkspaceContent(JSON.stringify({ direction, path, digest: digest ?? null, expectedHash: expectedHash ?? null }));
    const storageKey = `sidecar_artifact_transfer:${requestId}`;
    const prior = await this.ctx.storage.get<{ requestHash: string; status: string; result?: { request_id: string; direction: string; path: string; digest: string; bytes: number } }>(storageKey);
    if (prior && prior.requestHash !== requestHash) return Response.json({ error_code: "artifact_transfer_idempotency_conflict" }, { status: 409 });
    if (prior?.status === "complete" && prior.result) return Response.json({ status: "complete", ...prior.result });
    await this.ctx.storage.put(storageKey, { requestHash, status: "dispatching" });
    try {
      let transferDigest: string;
      let bytes: Uint8Array;
      let contentType: string | undefined;
      const privateKey = privatePrefix + path;
      if (direction === "import") {
        const artifactKey = environmentArtifactObjectKey({ tenantId: scope.tenantId, spaceId: scope.spaceId, ...(scope.projectId ? { projectId: scope.projectId } : {}) }, digest!);
        const artifact = await readBytesWithHash(bindings.SCRIPTS_R2, artifactKey, 16 * 1024 * 1024);
        if (!artifact || artifact.hash !== digest) return Response.json({ error_code: "environment_artifact_integrity_failed" }, { status: 404 });
        bytes = artifact.bytes; transferDigest = artifact.hash; contentType = artifact.contentType;
        const current = await readBytesWithHash(bindings.SCRIPTS_R2, privateKey, 16 * 1024 * 1024);
        // Idempotent recovery after a lost acknowledgement: the exact intended bytes already
        // occupy the installation-owned key, so the original operation is complete.
        if (current?.hash !== transferDigest) {
          if ((current?.hash ?? null) !== expectedHash) return Response.json({ error_code: "artifact_transfer_destination_conflict", current_hash: current?.hash ?? null }, { status: 409 });
          const head = await bindings.SCRIPTS_R2.head(privateKey);
          const stored = await bindings.SCRIPTS_R2.put(privateKey, bytes, { onlyIf: head?.etag ? { etagMatches: head.etag } : { etagDoesNotMatch: "*" },
            customMetadata: { sha256: transferDigest, transferRequestId: requestId }, ...(contentType ? { httpMetadata: { contentType } } : {}) });
          if (!stored) return Response.json({ error_code: "artifact_transfer_destination_conflict" }, { status: 409 });
        }
      } else {
        const source = await readBytesWithHash(bindings.SCRIPTS_R2, privateKey, 16 * 1024 * 1024);
        if (!source) return Response.json({ error_code: "artifact_transfer_source_missing" }, { status: 404 });
        bytes = source.bytes; transferDigest = source.hash; contentType = source.contentType;
        const artifactKey = environmentArtifactObjectKey({ tenantId: scope.tenantId, spaceId: scope.spaceId, ...(scope.projectId ? { projectId: scope.projectId } : {}) }, transferDigest);
        const saved = await bindings.SCRIPTS_R2.put(artifactKey, bytes, { onlyIf: { etagDoesNotMatch: "*" },
          customMetadata: { sha256: transferDigest, sourcePath: `sidecar:${scope.installationId}:${path}` }, ...(contentType ? { httpMetadata: { contentType } } : {}) });
        if (!saved) {
          const existing = await readBytesWithHash(bindings.SCRIPTS_R2, artifactKey, 16 * 1024 * 1024);
          if (existing?.hash !== transferDigest) return Response.json({ error_code: "environment_artifact_integrity_failed" }, { status: 409 });
        }
      }
      const result = { request_id: requestId, direction, path, digest: transferDigest, bytes: bytes.byteLength };
      await this.ctx.storage.put(storageKey, { requestHash, status: "complete", result });
      return Response.json({ status: "complete", ...result });
    } catch {
      await this.ctx.storage.put(storageKey, { requestHash, status: "indeterminate" });
      return Response.json({ error_code: "artifact_transfer_outcome_unknown", request_id: requestId }, { status: 503 });
    }
  }
}

/** Fixed default-policy bindings. Deployment pins are validated through inspect() before
 * execution; neither this subclass nor a manifest can select an arbitrary image at runtime. */
export class DocumentSandboxDO extends ToolSandboxDO {
  protected override workspaceRuntimeKind(): "document_sandbox" { return "document_sandbox"; }
}
export class MediaSandboxDO extends ToolSandboxDO {
  protected override workspaceRuntimeKind(): "media_sandbox" { return "media_sandbox"; }
}
