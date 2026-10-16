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
import { verifyInternalToken } from "@naelao/http";
import { infraTimeToCredits } from "@naelao/billing-core";
import { reserveWorkflowBudget, finalizeWorkflowBudget } from "../workflows/report-infra-usage.js";
import { validateContainerScope, type ContainerInvocationScope } from "../script-engine/container-policy.js";
import type { InstallationScope } from "@naelao/agent-sdk";
import type { Env } from "../env.js";
import { TRUSTED_PACKAGE_HOSTS } from "../script-engine/package-egress.js";

// The container runtime surface exposed on DurableObjectState (cast to stay
// version-agnostic across @cloudflare/workers-types).
interface ContainerPort {
  fetch(request: Request): Promise<Response>;
}
interface ContainerRuntime {
  readonly running: boolean;
  start(opts?: { enableInternet?: boolean; image?: string }): void;
  interceptOutboundHttps?(host: string, binding: ContainerPort): Promise<void>;
  getTcpPort(port: number): ContainerPort;
  inspect?(): Promise<{ image: string } | null>;
  destroy?(): Promise<void>;
  stop?(signal?: string): Promise<void> | void;
}

export interface SandboxWorkspaceScope {
  spaceId: string;
  projectId?: string;
  /** Space-wide extension instance. Its files live under Space Workspace, never the
   *  Space Assistant workspace. Project extensions continue using their project workspace. */
  installationId?: string;
  installationScope?: InstallationScope;
  branch?: string;
}

interface SandboxBindings {
  SCRIPTS_R2?: R2Bucket;
  CONCURRENCY_DO?: DurableObjectNamespace;
  PLATFORM_SECRET?: string;
  BILLING_WORKER?: Fetcher;
  ANALYTICS?: AnalyticsEngineDataset;
}

interface WorkspacePublication {
  scope: SandboxWorkspaceScope;
  changes: Array<{ path: string; expectedHash: string | null; newHash: string | null; stagedKey?: string }>;
}

const HARNESS_PORT = 8080;
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
interface ContainerMeter { tenantId: string; spaceId: string; reservationId: string; startedAt: number; expiresAt: number; allocatedAt?: number; endedAt?: number }
interface ContainerRuntimeMetrics { sidecar: boolean; coldStarts: number; startupMs: number; warmHits: number; warmIdleMs: number; executions: number; executionMs: number }
interface ExecutionRecord { scope: ContainerInvocationScope; payloadHash: string; status: "prepared" | "committed" | "indeterminate"; response?: { status: number; body: string } }

interface StoredShellState {
  cwd: string;
  env: Record<string, string>;
  gitHead: string;
  revision: number;
  stateHash: string;
}

export function isPortableWorkspacePath(path: string): boolean {
  return !path.replace(/\\/g, "/").split("/").includes("node_modules");
}

export function sandboxWorkspacePrefix(scope: SandboxWorkspaceScope): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(scope.spaceId)) throw new Error("invalid workspace space");
  const project = scope.projectId;
  if (project && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(project)) throw new Error("invalid workspace project");
  if (scope.installationScope === "SPACE_ASSISTANT" && project) throw new Error("assistant_runtime_project_scope_mismatch");
  if (scope.installationId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(scope.installationId)) throw new Error("invalid workspace installation");
  const branch = scope.branch?.replaceAll("\\", "/");
  if (branch && (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(branch) || branch.includes(".."))) throw new Error("invalid workspace branch");
  // Project-scoped extensions use their project workspace. Space-shared installations
  // receive a dedicated extension workspace; SPACE_ASSISTANT targets the normal assistant
  // workspace and is only valid without a project scope.
  const spaceExtension = scope.installationId && ["SPACE_SHARED", "SPACE_USER"].includes(scope.installationScope ?? "");
  const base = spaceExtension
    ? `spaces/${scope.spaceId}/space-workspace/extensions/${scope.installationId}/workspace/`
    : scope.installationScope === "SPACE_ASSISTANT"
      ? `spaces/${scope.spaceId}/workspace/`
    : project
      ? `spaces/${scope.spaceId}/projects/${project}/workspace/`
      : scope.installationId
        ? `spaces/${scope.spaceId}/space-workspace/extensions/${scope.installationId}/workspace/`
        : `spaces/${scope.spaceId}/workspace/`;
  return branch ? `${base}branches/${branch}/` : base;
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
  private activeExecution: { id: string; controller: AbortController } | undefined;

  override fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/output") return this.output(request);
    if (path === "/cancel") return this.cancel(request);
    const execution = this.executionQueue.then(() => ["/exec", "/shell", "/build", "/prewarm", "/computer/action", "/computer/screenshot", "/pdf/render", "/media/extract-audio"].includes(path)
      ? this.executeScoped(request) : (async () => {
        try { await this.authenticatedScope(request); }
        catch { return Response.json({ ok: false, error: "container_scope_denied" }, { status: 403 }); }
        return this.handleRequest(request);
      })());
    this.executionQueue = execution.then(() => undefined, () => undefined);
    return execution;
  }

  private get container(): ContainerRuntime | undefined {
    const raw = (this.ctx as unknown as { container?: ContainerRuntime }).container;
    if (!raw) return undefined;
    return { get running() { return raw.running; }, start: options => raw.start(options),
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
    return scope;
  }

  private async output(request: Request): Promise<Response> {
    let scope: ContainerInvocationScope;
    try { scope = await this.authenticatedScope(request); } catch { return Response.json({ error: "container_scope_denied" }, { status: 403 }); }
    const record = await this.ctx.storage.get<ExecutionRecord>("execution:" + scope.executionId);
    if (!record || JSON.stringify(record.scope) !== JSON.stringify(scope)) return Response.json({ error: "container_execution_not_found" }, { status: 404 });
    if (!this.container?.running) return Response.json({ stdout: "", stderr: "" });
    return this.container.getTcpPort(HARNESS_PORT).fetch(new Request("http://sandbox/output", {
      headers: { "x-naelao-execution-id": scope.executionId }, signal: request.signal,
    }));
  }

  private async ensureMeter(scope: ContainerInvocationScope): Promise<void> {
    const existing = await this.ctx.storage.get<ContainerMeter>("container_meter");
    if (existing?.endedAt !== undefined) await this.settleMeter();
    if (existing && existing.endedAt === undefined) {
      if (existing.expiresAt <= Date.now() + scope.timeoutMs) { await this.stopContainer(); throw new Error("container_capacity_reservation_expired_retry"); }
      return;
    }
    const now = Date.now();
    const meter: ContainerMeter = { tenantId: scope.tenantId, spaceId: scope.spaceId, reservationId: "container:" + crypto.randomUUID(), startedAt: now, expiresAt: now + 360000 };
    // Persist the reservation intent before contacting billing so retries use the same key.
    let pending = await this.ctx.storage.get<ContainerMeter>("container_reservation_pending") ?? meter;
    if (pending.expiresAt <= now) {
      await finalizeWorkflowBudget(this.env as Env, pending.tenantId, pending.reservationId, "release");
      pending = meter;
    }
    await this.ctx.storage.put("container_reservation_pending", pending);
    await this.ctx.storage.setAlarm(pending.expiresAt);
    await reserveWorkflowBudget(this.env as Env, pending.tenantId, pending.spaceId, pending.reservationId,
      "container:" + scope.spaceId + ":" + (scope.projectId ?? "assistant"), infraTimeToCredits("container", 360000), pending.expiresAt);
    await this.ctx.storage.put("container_meter", pending);
    await this.ctx.storage.delete("container_reservation_pending");
  }

  private async settleMeter(): Promise<void> {
    const meter = await this.ctx.storage.get<ContainerMeter>("container_meter");
    if (!meter) return;
    meter.endedAt ??= Date.now();
    await this.ctx.storage.put("container_meter", meter);
    const allocatedMs = meter.allocatedAt === undefined ? 0 : Math.max(0, meter.endedAt - meter.allocatedAt);
    const credits = infraTimeToCredits("container", allocatedMs);
    await finalizeWorkflowBudget(this.env as Env, meter.tenantId, meter.reservationId, "settle", credits);
    await this.ctx.storage.put("last_container_gas", { ...meter, credits });
    const metrics = await this.ctx.storage.get<ContainerRuntimeMetrics>("container_runtime_metrics");
    const analytics = (this.env as unknown as SandboxBindings).ANALYTICS;
    if (metrics && analytics) {
      try {
        analytics.writeDataPoint({
          blobs: ["container.runtime.lifecycle", metrics.sidecar ? "marketplace-sidecar" : "base", "tool-sandbox", "", "", "", "", "", ""],
          doubles: [allocatedMs, credits, metrics.coldStarts, metrics.startupMs, metrics.warmHits, metrics.warmIdleMs, metrics.executions, metrics.executionMs],
        });
      } catch { /* telemetry must never delay or prevent billing settlement */ }
    }
    await this.ctx.storage.delete("container_runtime_metrics");
    await this.ctx.storage.delete("sidecar_last_active_at");
    await this.ctx.storage.delete("container_meter");
  }

  private async updateRuntimeMetrics(update: Partial<Record<keyof Omit<ContainerRuntimeMetrics, "sidecar">, number>>, sidecar?: boolean): Promise<void> {
    const current = await this.ctx.storage.get<ContainerRuntimeMetrics>("container_runtime_metrics")
      ?? { sidecar: sidecar === true, coldStarts: 0, startupMs: 0, warmHits: 0, warmIdleMs: 0, executions: 0, executionMs: 0 };
    if (sidecar !== undefined) current.sidecar = sidecar;
    for (const [key, value] of Object.entries(update) as Array<[keyof typeof update, number]>) current[key] += value;
    await this.ctx.storage.put("container_runtime_metrics", current);
  }

  private async stopContainer(): Promise<void> {
    const container = this.container;
    if (container?.running) {
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
    const body = await request.clone().text();
    const payloadHash = await hashWorkspaceContent(new URL(request.url).pathname + body);
    const key = "execution:" + scope.executionId;
    const previous = await this.ctx.storage.get<ExecutionRecord>(key);
    if (previous) {
      if (previous.payloadHash !== payloadHash || JSON.stringify(previous.scope) !== JSON.stringify(scope)) return Response.json({ ok: false, error: "container_execution_conflict" }, { status: 409 });
      if (previous.status === "committed" && previous.response) return new Response(previous.response.body, { status: previous.response.status, headers: { "content-type": "application/json" } });
      return Response.json({ ok: false, error: "container_execution_reconciliation_required" }, { status: 409 });
    }
    await this.ctx.storage.put(key, { scope, payloadHash, status: "prepared" } satisfies ExecutionRecord);
    let retainSidecarWarm = false;
    let metered = false;
    const startedAt = Date.now();
    const sidecarWasWarm = Boolean(scope.installationId && this.container?.running);
    const controller = new AbortController();
    this.activeExecution = { id: scope.executionId, controller };
    const abort = () => controller.abort();
    let executionLimitExceeded = false;
    request.signal.addEventListener("abort", abort, { once: true });
    const remaining = Math.min(scope.timeoutMs, scope.deadline - Date.now());
    const timer = setTimeout(() => { executionLimitExceeded = true; abort(); }, Math.max(1, remaining));
    const headers = new Headers(request.headers);
    headers.set("x-naelao-execution-id", scope.executionId); headers.set("x-naelao-timeout-ms", String(Math.max(1, remaining - 1000)));
    try {
      if (request.signal.aborted || await this.ctx.storage.get("cancelled:" + scope.executionId)) throw new Error("container_cancelled");
      await this.ensureMeter(scope);
      metered = true;
      if (sidecarWasWarm) {
        const lastActiveAt = await this.ctx.storage.get<number>("sidecar_last_active_at");
        await this.updateRuntimeMetrics({ warmHits: 1, warmIdleMs: lastActiveAt === undefined ? 0 : Math.max(0, startedAt - lastActiveAt) }, true);
      }
      await this.updateRuntimeMetrics({ executions: 1 }, Boolean(scope.installationId));
      if (controller.signal.aborted) throw new Error("container_cancelled_or_deadline");
      const response = await Promise.race([
        this.handleRequest(new Request(request, { headers, signal: controller.signal })),
        new Promise<Response>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("container_cancelled_or_deadline")), { once: true })),
      ]);
      if (controller.signal.aborted) throw new Error("container_cancelled_or_deadline");
      retainSidecarWarm = Boolean(scope.installationId && response.ok);
      const responseBody = await response.clone().text();
      if (new URL(request.url).pathname !== "/computer/screenshot") {
        if (new TextEncoder().encode(responseBody).byteLength > 2 * 1024 * 1024) throw new Error("container_output_limit");
        await this.ctx.storage.put(key, { scope, payloadHash, status: "committed", response: { status: response.status, body: responseBody } } satisfies ExecutionRecord);
      } else await this.ctx.storage.put(key, { scope, payloadHash, status: "indeterminate" } satisfies ExecutionRecord);
      return response;
    } catch (error) {
      controller.abort();
      await this.ctx.storage.put(key, { scope, payloadHash, status: "indeterminate" } satisfies ExecutionRecord);
      if (metered) {
        await this.updateRuntimeMetrics({ executionMs: Math.max(0, Date.now() - startedAt) }, Boolean(scope.installationId));
        metered = false;
      }
      await this.stopContainer().catch(() => this.ctx.storage.setAlarm(Date.now() + 1000));
      const message = executionLimitExceeded
        ? `container_execution_time_limit_exceeded: maximum ${scope.timeoutMs}ms; move waits and schedules to a Durable Workflow and keep each container step bounded`
        : String(error);
      return Response.json({ ok: false, error: message, workspace_may_require_reconciliation: true }, { status: 409 });
    } finally {
      clearTimeout(timer); request.signal.removeEventListener("abort", abort); this.activeExecution = undefined;
      if (scope.installationId) {
        await this.ctx.storage.delete("task_active");
        if (retainSidecarWarm) {
          const expiresAt = Date.now() + SIDECAR_WARM_LEASE_MS;
          await this.ctx.storage.put("sidecar_warm_expires_at", expiresAt);
          await this.ctx.storage.put("sidecar_last_active_at", Date.now());
          await this.ctx.storage.setAlarm(Math.min(expiresAt, (await this.ctx.storage.get<ContainerMeter>("container_meter"))?.expiresAt ?? Infinity));
        } else await this.stopContainer().catch(() => this.ctx.storage.setAlarm(Date.now() + 1000));
      }
      if (metered) await this.updateRuntimeMetrics({ executionMs: Math.max(0, Date.now() - startedAt) }, Boolean(scope.installationId));
    }
  }

  private workspacePrefix(scope: SandboxWorkspaceScope): string {
    return sandboxWorkspacePrefix(scope);
  }

  private async *listR2Workspace(prefix: string): AsyncGenerator<{ path: string; bytes: Uint8Array; hash: string }> {
    const bucket = (this.env as unknown as SandboxBindings).SCRIPTS_R2;
    if (!bucket) throw new Error("Canonical workspace R2 binding is unavailable");
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}), limit: 1000, include: ["customMetadata"] } as R2ListOptions & { include: string[] });
      for (const item of page.objects) {
        if (item.customMetadata?.deleted === "true") continue;
        const path = item.key.slice(prefix.length);
        if (prefix.endsWith("/workspace/") && path.startsWith("branches/")) continue;
        if (!isSyncableWorkspacePath(path)) continue;
        const object = await readBytesWithHash(bucket, item.key);
        if (!object) throw new Error(`Workspace object disappeared during hydration: ${path}`);
        yield { path, bytes: object.bytes, hash: object.hash };
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }

  private async hydrateWorkspace(container: ContainerRuntime, scope: SandboxWorkspaceScope): Promise<void> {
    const prefix = this.workspacePrefix(scope);
    const expectedHashes: Record<string, string> = {};
    for await (const { path, bytes, hash } of this.listR2Workspace(prefix)) {
      const response = await container.getTcpPort(HARNESS_PORT).fetch(new Request("http://sandbox/workspace/write", {
        method: "POST", headers: { "content-type": "application/json", "x-avos-restore": "1" },
        body: JSON.stringify({ files_base64: { [path]: bytesToBase64(bytes) } }),
      }));
      if (!response.ok) throw new Error(`Workspace hydration failed (${response.status}): ${path}`);
      expectedHashes[path] = hash;
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
  }

  private async publishWorkspaceChanges(container: ContainerRuntime, scope: SandboxWorkspaceScope, holderId: string): Promise<{ changed: number }> {
    const bindings = this.env as unknown as SandboxBindings;
    if (!bindings.SCRIPTS_R2 || !bindings.CONCURRENCY_DO) throw new Error("Fenced workspace publication is unavailable");
    const prefix = this.workspacePrefix(scope);
    const port = container.getTcpPort(HARNESS_PORT);
    const listed = await port.fetch(new Request("http://sandbox/workspace/list", { method: "POST" }));
    if (!listed.ok) throw new Error(`Workspace listing failed (${listed.status})`);
    const listResult = await listed.json<{ files: string[] }>();
    const currentPaths = new Set(listResult.files.filter(isSyncableWorkspacePath));
    const priorHashes = (await this.ctx.storage.get<Record<string, string>>("workspace_hashes")) ?? {};
    const paths = [...new Set([...Object.keys(priorHashes), ...currentPaths])].sort();
    const changes: WorkspacePublication["changes"] = [];
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
      }
      const bytes = currentBase64 === undefined ? null : Uint8Array.from(atob(currentBase64), (character) => character.charCodeAt(0));
      const digest = bytes ? await crypto.subtle.digest("SHA-256", bytes) : undefined;
      const newHash = digest ? [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("") : null;
      const expectedHash = priorHashes[path] ?? null;
      if (newHash === expectedHash) continue;
      const stagedKey = bytes ? `workspace-staging/${scope.spaceId}/${scope.projectId ?? "_assistant"}/${holderId}/${newHash}` : undefined;
      if (bytes && stagedKey) await bindings.SCRIPTS_R2.put(stagedKey, bytes, { customMetadata: { sha256: newHash! }, onlyIf: { etagDoesNotMatch: "*" } });
      changes.push({ path, expectedHash, newHash, ...(stagedKey ? { stagedKey } : {}) });
    }
    if (!changes.length) return { changed: 0 };
    // The journal is written before the first remote publication. Recovery completes the same
    // intended revisions, including a publication whose response was lost, before hydration.
    await this.ctx.storage.put("workspace_pending_publication", { scope, changes } satisfies WorkspacePublication);
    await this.replayWorkspacePublication(holderId);
    return { changed: changes.length };
  }

  private async replayWorkspacePublication(holderId: string): Promise<void> {
    const publication = await this.ctx.storage.get<WorkspacePublication>("workspace_pending_publication");
    if (!publication) return;
    const bindings = this.env as unknown as SandboxBindings;
    if (!bindings.SCRIPTS_R2 || !bindings.CONCURRENCY_DO) throw new Error("Fenced workspace recovery is unavailable");
    const { scope, changes } = publication;
    const prefix = this.workspacePrefix(scope);
    const nextHashes = (await this.ctx.storage.get<Record<string, string>>("workspace_hashes")) ?? {};
    for (const change of changes) {
      const { path, expectedHash, newHash, stagedKey } = change;
      const key = `${prefix}${path}`;
      const current = await readBytesWithHash(bindings.SCRIPTS_R2, key);
      if ((current?.hash ?? null) === newHash) {
        if (newHash) nextHashes[path] = newHash;
        else delete nextHashes[path];
        continue;
      }
      const staged = stagedKey ? await readBytesWithHash(bindings.SCRIPTS_R2, stagedKey) : null;
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
    const stagedKeys = changes.flatMap((change) => change.stagedKey ? [change.stagedKey] : []);
    if (stagedKeys.length) await bindings.SCRIPTS_R2.delete(stagedKeys).catch(() => undefined);
  }

  override async alarm(): Promise<void> {
    const pending = await this.ctx.storage.get<ContainerMeter>("container_reservation_pending");
    if (pending && pending.expiresAt <= Date.now()) {
      await finalizeWorkflowBudget(this.env as Env, pending.tenantId, pending.reservationId, "release");
      await this.ctx.storage.delete("container_reservation_pending");
    }
    const meter = await this.ctx.storage.get<ContainerMeter>("container_meter");
    if (meter?.endedAt !== undefined || meter && meter.expiresAt <= Date.now()) {
      this.activeExecution?.controller.abort();
      await this.stopContainer(); return;
    }
    if (this.activeExecution) { await this.ctx.storage.setAlarm(Date.now() + 1000); return; }
    const sidecarExpiresAt = await this.ctx.storage.get<number>("sidecar_warm_expires_at");
    if (sidecarExpiresAt !== undefined && sidecarExpiresAt <= Date.now()) {
      await this.stopContainer();
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
        await port.fetch(new Request("http://sandbox/shutdown", { method: "POST" })).catch(() => undefined);
        await this.stopContainer();
      }
      else await this.settleMeter();
      await this.ctx.storage.put("container_status", "hibernated");
    } else {
      await this.ctx.storage.setAlarm(Math.min(lastUsed + idleWindow, meter?.expiresAt ?? Infinity));
    }
  }

  private async handleRequest(request: Request): Promise<Response> {
    if (request.signal.aborted) throw new Error("container_cancelled");
    const url = new URL(request.url);
    let execScope: SandboxWorkspaceScope | undefined;
    if (url.pathname === "/exec" && request.method === "POST") {
      const body = await request.clone().json<{ spaceId?: string; projectId?: string; workspaceBranch?: string }>().catch((): { spaceId?: string; projectId?: string; workspaceBranch?: string } => ({}));
      const containerScope = JSON.parse(request.headers.get("x-naelao-container-scope") ?? "null") as ContainerInvocationScope | null;
      if (!containerScope || body.spaceId !== undefined && body.spaceId !== containerScope.spaceId
        || body.projectId !== undefined && body.projectId !== containerScope.projectId)
        return Response.json({ ok: false, error: "sandbox_workspace_identity_mismatch" }, { status: 403 });
      execScope = {
        spaceId: containerScope.spaceId,
        ...(containerScope.projectId ? { projectId: containerScope.projectId } : {}),
        ...(containerScope?.installationId ? { installationId: containerScope.installationId } : {}),
        ...(containerScope?.installationScope ? { installationScope: containerScope.installationScope } : {}),
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
      const body = await request.json<{ status?: "active" | "blocked" | "completed" }>()
        .catch((): { status?: "active" | "blocked" | "completed" } => ({}));
      if (body.status === "active") await this.ctx.storage.put("task_active", true);
      else if (body.status === "blocked" || body.status === "completed") await this.ctx.storage.delete("task_active");
      else return Response.json({ error: "status must be active, blocked, or completed" }, { status: 400 });
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
      const body: SyncBody = await request.json<SyncBody>().catch(() => ({}));
      const records = (await this.ctx.storage.get<Record<string, WorkspaceRecord>>("workspace_files")) ?? {};
      const conflicts: string[] = [];
      for (const [path, change] of Object.entries(body.files ?? {})) {
        if (path.split("/").includes("node_modules")) continue;
        const actual = records[path]?.hash ?? null;
        if (change.expected_hash !== undefined && change.expected_hash !== actual) conflicts.push(path);
      }
      for (const [path, expected] of Object.entries(body.deleted ?? {}))
        if (records[path]?.hash !== expected) conflicts.push(path);
      if (conflicts.length) return Response.json({ error: "workspace_state_conflict", conflicts }, { status: 409 });
      let lockfilesChanged = false;
      for (const [path, change] of Object.entries(body.files ?? {})) {
        if (path.split("/").includes("node_modules")) continue;
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(change.content));
        const hash = [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, "0")).join("");
        if (records[path]?.hash !== hash && (path === "package.json" || path === "package-lock.json")) lockfilesChanged = true;
        records[path] = { content: change.content, hash };
      }
      for (const path of Object.keys(body.deleted ?? {})) if (isPortableWorkspacePath(path)) delete records[path];
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
      // Container internet stays disabled. Native HTTPS interceptions forward only the
      // exact package hosts; redirects to any other host cannot escape the boundary.
      if (!container.interceptOutboundHttps) return Response.json({ ok: false, error: "package_egress_interception_unavailable" }, { status: 503 });
      const exports = (this.ctx as unknown as { exports?: { PackageEgress?: (options: { props: Record<string, never> }) => ContainerPort } }).exports;
      const packageEgress = exports?.PackageEgress?.({ props: {} });
      if (!packageEgress) return Response.json({ ok: false, error: "package_egress_binding_unavailable" }, { status: 503 });
      for (const host of TRUSTED_PACKAGE_HOSTS) await container.interceptOutboundHttps(host, packageEgress);
      const startScope = JSON.parse(request.headers.get("x-naelao-container-scope") ?? "null") as ContainerInvocationScope | null;
      // Marketplace sidecars are immutable deployment-approved digests implementing the same
      // harness protocol. Select only the authenticated installation's pin; never accept an
      // image from the execution body or model-generated command.
      container.start({ enableInternet: false, ...(startScope?.dynamicImage && startScope.image ? { image: startScope.image } : {}) });
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
    if (requestedScope?.image) {
      const actual = await container.inspect?.();
      if (!actual?.image || actual.image !== requestedScope.image) throw new Error("container_deployed_image_digest_mismatch");
      const installedOwner = JSON.stringify([requestedScope.installationId, requestedScope.runId, requestedScope.image]);
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
      if (coldStart || !currentScope || url.pathname === "/exec") await this.hydrateWorkspace(container, execScope);
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
      const files = body.files ?? {};
      const expected = body.expected_hashes;
      const restoring = request.headers.get("x-avos-restore") === "1";
      const records = (await this.ctx.storage.get<Record<string, WorkspaceRecord>>("workspace_files")) ?? {};
      if (!restoring) {
        if (!expected || Object.keys(files).some(path => !Object.prototype.hasOwnProperty.call(expected, path))) {
          return Response.json({ error: "workspace_hash_required", message: "expected_hashes are required for every workspace write" }, { status: 400 });
        }
        const conflicts: string[] = [];
        const nextRecords = { ...records };
        for (const [path, content] of Object.entries(files)) {
          if (!isPortableWorkspacePath(path)) continue;
          const actual = records[path]?.hash ?? null;
          if (expected[path] !== actual) conflicts.push(path);
          const nextHash = await hashWorkspaceContent(content);
          nextRecords[path] = { content, hash: nextHash };
        }
        if (conflicts.length) return Response.json({ error: "workspace_state_conflict", conflicts }, { status: 409 });
        await this.ctx.storage.put("workspace_files", nextRecords);
      }
      const forwarded = new Request(request, { body: JSON.stringify({ files }), headers: request.headers });
      return container.getTcpPort(HARNESS_PORT).fetch(forwarded);
    }

    // /build and the remaining /workspace/* routes forward to the harness. Tier-6 execution
    // hydrates from canonical R2 on a cold workspace and publishes each changed file through the
    // same fenced CAS gateway used by the other workspace writers before returning to the agent.
    const response = await container.getTcpPort(HARNESS_PORT).fetch(request);
    if (url.pathname === "/exec" && execScope && (this.env as unknown as SandboxBindings).SCRIPTS_R2) {
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
}

/** Fixed default-policy bindings. Deployment pins are validated through inspect() before
 * execution; neither this subclass nor a manifest can select an arbitrary image at runtime. */
export class DocumentSandboxDO extends ToolSandboxDO {}
export class MediaSandboxDO extends ToolSandboxDO {}
