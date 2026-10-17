/** Execution backends: validated fresh Dynamic Workers for JS/TS and provider Python/Wasm;
 * durable Workflows for long jobs, browser services for perception, cloud/local containers
 * for authorized native execution. Only explicit scoped RPC capabilities cross into guests.
 */

import { mintInternalToken } from "@naelao/http";
import { assertBrowserUrl, browserEngineFor, validateBrowserScope, type BrowserActionKind, type BrowserObservation, type BrowserRuntimeScope } from "@naelao/agent-sdk";
import { browserPerceptionReceipt, chooseBrowserReflex, type BrowserActionCandidate } from "./browser-perception.js";
import type {
  ExecutionTier,
  ScriptRunResult,
  TieredCodeRunner,
} from "./types.js";
import { type ContainerBackend, type Tier6ContainerOptions, type ScopedCodeRpcOptions } from "@naelao/agent-sdk";
import { runIsolate, runBoundChannelIsolate, codeFailure } from "./isolated-runtime.js";
import type { CodeRpcBinding } from "./code-rpc-broker.js";
import { validateContainerScope, sidecarKey, assertBrowserContainerLease, type ContainerInvocationScope, type BrowserContainerLease, type InstalledContainer } from "./container-policy.js";

// ── CF Worker Loader binding (beta) — minimal local typing ─────────────────────────────

export interface WorkerLoaderModuleConfig {
  compatibilityDate: string;
  compatibilityFlags?: string[];
  mainModule: string;
  modules: Record<string, string | { js: string } | { py: string } | { wasm: ArrayBuffer }>;
  limits?: { cpuMs: number; subRequests: number };
  /** Provider-serialized scope and explicit custom RPC binding; no raw host env. */
  env?: Record<string, unknown>;
  /** Restrict outbound fetch from the loaded worker; null disables outbound entirely. */
  globalOutbound?: Fetcher | null;
}

export interface WorkerLoaderStub {
  getEntrypoint(
    name?: string,
    options?: { props?: Record<string, unknown>; limits?: { cpuMs: number; subRequests: number } }
  ): Fetcher;
}

export interface WorkerLoaderBinding {
  load?(config: WorkerLoaderModuleConfig): WorkerLoaderStub;
  get(
    id: string,
    factory: () => WorkerLoaderModuleConfig | Promise<WorkerLoaderModuleConfig>
  ): WorkerLoaderStub;
}

// ── Options the host (NaelaoAgentDO) supplies when constructing the runner ─────────────

export interface CodeRunnerOptions {
  /** Loopback custom binding factory; never pass raw services/credentials into guest env. */
  createRpcBinding?: (options: ScopedCodeRpcOptions, deadline: number) => Promise<{ binding: CodeRpcBinding; close(): void }>;
  authorizeCodeCapability?: ScopedCodeRpcOptions["authorize"];
  dispatchCodeCapability?: ScopedCodeRpcOptions["dispatch"];
  maxConcurrentIsolates?: number;
  maxConcurrentPerTenant?: number;
  /** Pinned provider memory ceiling; Workers currently enforce 128 MiB per isolate. */
  isolateMemoryMb?: number;
  pythonEnabled?: boolean;
  approveEscalation?: (params: Parameters<TieredCodeRunner["run"]>[0], capability: string) => Promise<boolean>;
  /** Fail-closed compliance mode: no browser, MCP, package CDN, or cloud-container egress. */
  airGappedOnly?: boolean;
  /** The worker_loaders binding. Tiers 2-4 are unavailable without it. */
  loader?: WorkerLoaderBinding;
  /** naelao-browser service binding (Tier 4). */
  browserWorker?: Fetcher;
  /** Live host grant check; page/model text can never grant a browser operation. */
  authorizeBrowser?: (scope: BrowserRuntimeScope, operation: string) => Promise<boolean>;
  browserDecisionGateway?: () => import("@naelao/agent-sdk").FastDecisionGateway | undefined;
  /** naelao-mcp-hub service binding — powers Tiers 2-4's ctx.mcp (§A1.17 Phase I). */
  mcpHubWorker?: Fetcher;
  /** Zero-leak credential egress worker. Only this binding receives logical credential names. */
  credentialsWorker?: Fetcher;
  /** Used to mint short-lived internal tokens for the browser/mcp-hub loopbacks — never handed
   *  to the isolate directly. */
  platformSecret?: string;
  /** ToolSandboxDO namespace (Tier 6, the Phase K base per-project sandbox). */
  toolSandbox?: DurableObjectNamespace;
  /** Marks container calls as part of a still-active Task DAG run. ToolSandboxDO uses this to
   *  hold the warm container for five minutes between edit/build/test steps. */
  activeTask?: boolean;
  /** Browser-owned WebContainer bridge, when a live tab advertises one. */
  webContainer?: Fetcher;
  /** LocalTunnelDO namespace for explicitly selected workstation execution. */
  localTunnel?: DurableObjectNamespace<import("../do/LocalTunnelDO.js").LocalTunnelDO>;
  localMachine?: (params: Parameters<TieredCodeRunner["run"]>[0]) => Promise<import("./types.js").ScriptRunResult>;
  /** §A1.17 Phase L: Container Marketplace image id -> its own DO namespace binding. Empty/absent
   *  today — every catalogue image ships `available:false` (see container-catalogue.ts) until a
   *  real Dockerfile + persistence strategy + wrangler binding lands for it. */
  containerImages?: Record<string, DurableObjectNamespace>;
  /** Host resolves the active installation and an approved fixed binding, not model text. */
  authorizeContainer?: (params: Parameters<TieredCodeRunner["run"]>[0]) => Promise<boolean>;
  resolveSidecar?: (params: Parameters<TieredCodeRunner["run"]>[0]) => Promise<{ installation: InstalledContainer; namespace: DurableObjectNamespace; dynamicImage?: boolean }>;
  browserContainerLease?: () => Promise<BrowserContainerLease | undefined>;
  browserCompatible?: (params: Parameters<TieredCodeRunner["run"]>[0]) => Promise<boolean>;
  /** Per-call wall-clock timeout for isolate tiers (2-4). Default 15s. */
  isolateTimeoutMs?: number;
  /** Per-call wall-clock timeout for the container tier (6). Default 60s. */
  containerTimeoutMs?: number;
}

const DEFAULT_CONTAINER_TIMEOUT_MS = 60_000;

async function runBrowser(
  opts: CodeRunnerOptions,
  params: Parameters<TieredCodeRunner["run"]>[0],
  requestedEngine: "kitesurf" | "chromium",
  sessions: Map<string, BrowserRuntimeScope>
): Promise<ScriptRunResult> {
  const started = Date.now();
  let engine = requestedEngine;
  let fallbackReason: string | undefined;
  let scope: BrowserRuntimeScope | undefined;
  let aborted = false;
  const operation = params.name.replace(/^browser-use\./, "");
  const mutation = ["click", "type", "select", "scroll", "act"].includes(operation);
  const endpoint = mutation ? "act" : operation === "reflex" ? "snapshot" : ["extract", "screenshot"].includes(operation) ? "observe" : operation;
  const fail = (message: string): ScriptRunResult => ({ ok: false, error: message, tier: engine === "kitesurf" ? 4 : 5,
    actual_tier: engine === "kitesurf" ? 4 : 5, engine, duration_ms: Date.now() - started, tokens_used: 0 });
  if (opts.airGappedOnly) return fail("compliance_violation: browser egress is disabled for local-only spaces");
  if (!opts.browserWorker || !opts.platformSecret || !opts.authorizeBrowser) return fail("browser_runtime_unavailable");
  if (!params.userId || !params.runId || params.userId === "system") return fail("browser_actor_and_run_required");
  const maxTier = params.maxTier ?? 4;
  if (maxTier < 4) return fail("execution_ceiling_exceeded");
  const sessionId = typeof params.args["session_id"] === "string" ? params.args["session_id"] : crypto.randomUUID();
  const key = JSON.stringify([params.tenantId, params.spaceId, params.projectId, params.userId, params.runId, sessionId]);
  const saved = sessions.get(key);
  try {
    const rawUrl = typeof params.args["url"] === "string" ? params.args["url"] : saved?.authorizedOrigins[0];
    if (!rawUrl) return fail("browser_url_and_session_required");
    const origin = new URL(rawUrl).origin;
    scope = { tenantId: params.tenantId, spaceId: params.spaceId, actorId: params.userId, agentId: params.agentId,
      runId: params.runId, sessionId, ...(params.projectId ? { projectId: params.projectId } : {}),
      expiresAt: saved?.expiresAt ?? Date.now() + 600_000, authorizedOrigins: saved?.authorizedOrigins ?? [origin],
      authorizedActions: [], maxTier: Math.min(maxTier, 6) as 4 | 5 | 6 };
    validateBrowserScope(scope);
    assertBrowserUrl(scope, rawUrl);
    const capability = "browser." + (operation === "act" ? String((params.args["action"] as Record<string, unknown> | undefined)?.["type"] ?? "") : operation);
    if (!await opts.authorizeBrowser(scope, capability)) return fail("browser_operation_not_authorized");
    const actions: BrowserActionKind[] = [];
    for (const action of ["click", "type", "select", "scroll"] as const) if (await opts.authorizeBrowser(scope, "browser." + action)) actions.push(action);
    scope.authorizedActions = actions;
    const chosen = browserEngineFor(scope, {
      visual: requestedEngine === "chromium" || operation === "screenshot" || operation === "see" || Boolean(params.args["needsScreenshot"] || params.args["take_screenshot"]),
      webgl: Boolean(params.args["needsWebGL"] || params.args["needsCanvas"]),
      persistentLogin: Boolean(params.args["interactive"]),
    });
    engine = chosen.engine; fallbackReason = chosen.reason;
    // Grant and identity come only from the host. Model arguments cannot replace scope.
    const body: Record<string, unknown> = { scope,
      ...(typeof params.args["url"] === "string" ? { url: params.args["url"] } : {}),
      interactive: Boolean(params.args["interactive"]), pixelAccurate: engine === "chromium", visual: operation === "screenshot" || Boolean(params.args["take_screenshot"]),
      webgl: Boolean(params.args["needsWebGL"] || params.args["needsCanvas"]),
      ...(operation === "see" ? { path: String(params.args["path"] ?? "latest") } : {}) };
    if (mutation) body["action"] = operation === "act" ? params.args["action"] : {
      type: operation, actionId: String(params.args["action_id"] ?? ""),
      observationRevision: String(params.args["observation_revision"] ?? ""), handle: params.args["handle"],
      ...(operation === "type" ? { text: params.args["text"] } : {}),
      ...(operation === "select" ? { value: params.args["value"] } : {}),
      ...(operation === "scroll" ? { x: params.args["x"], y: params.args["y"] } : {}),
    };
    const headers = { "content-type": "application/json", "x-naelao-tenant-id": params.tenantId,
      "x-naelao-internal-token": await mintInternalToken(opts.platformSecret, params.tenantId) };
    const send = (method: string, signal?: AbortSignal) => opts.browserWorker!.fetch(new Request("http://browser/v1/browser/" + method, {
      method: "POST", headers, body: JSON.stringify(body), ...(signal ? { signal } : {}) }));
    sessions.set(key, scope);
    const cancel = () => { aborted = true; void send("cancel").catch(() => undefined); };
    params.signal?.throwIfAborted();
    params.signal?.addEventListener("abort", cancel, { once: true });
    try {
      // Never replay a failed request on another engine: it may already have acted.
      const response = await send(endpoint, params.signal);
      if (params.signal?.aborted || aborted) return fail("browser_session_cancelled");
      if (operation === "see" && response.ok && response.headers.get("content-type")?.includes("image/png")) {
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > 4 * 1024 * 1024) return fail("browser_screenshot_limit");
        engine = "chromium";
        return { ok: true, output: { image_base64: btoa(Array.from(new Uint8Array(bytes), byte => String.fromCharCode(byte)).join("")), mime_type: "image/png", session_id: sessionId },
          tier: 5, actual_tier: 5, engine, duration_ms: Date.now() - started, tokens_used: 0 };
      }
      let result = await response.json<{ ok?: boolean; result?: BrowserObservation; engine_used?: string; error_code?: string; message?: string }>();
      if (!response.ok || result.ok === false) return fail(result.error_code ?? "browser_provider_error");
      if (result.engine_used === "chromium" || result.engine_used === "kitesurf") engine = result.engine_used;
      if (engine === "chromium" && maxTier < 5) return fail("browser_escalation_exceeds_ceiling");
      if (operation === "reflex" && result.result) {
        const candidates = Array.isArray(params.args["candidates"]) ? params.args["candidates"] as BrowserActionCandidate[] : [];
        const decision = await chooseBrowserReflex(scope, result.result, candidates, opts.browserDecisionGateway?.());
        if (decision.kind !== "action") return { ok: true, output: decision, tier: engine === "chromium" ? 5 : 4, actual_tier: engine === "chromium" ? 5 : 4, engine, duration_ms: Date.now() - started, tokens_used: 0 };
        if (!decision.action || !await opts.authorizeBrowser(scope, "browser." + decision.action.type)) return fail("browser_operation_not_authorized");
        body["action"] = decision.action;
        const acted = await send("act", params.signal);
        result = await acted.json<typeof result>();
        if (!acted.ok || result.ok === false) return fail(result.error_code ?? "browser_action_reconciliation_required");
        if (params.signal?.aborted) return fail("browser_session_cancelled");
      }
      if (operation === "close" || operation === "cancel") sessions.delete(key);
      return { ok: true, output: result.result ? { ...browserPerceptionReceipt(result.result), ...(fallbackReason ? { escalation_reason: fallbackReason } : {}) } : result,
        tier: engine === "kitesurf" ? 4 : 5, actual_tier: engine === "kitesurf" ? 4 : 5, engine,
        duration_ms: Date.now() - started, tokens_used: 0 };
    } finally { params.signal?.removeEventListener("abort", cancel); }
  } catch (error) {
    return fail(error instanceof Error && /^browser_[a-z_]+$/.test(error.message) ? error.message : "browser_connection_interrupted");
  }
}

async function runContainer(
  opts: CodeRunnerOptions,
  params: Parameters<TieredCodeRunner["run"]>[0]
): Promise<ScriptRunResult> {
  const started = Date.now();
  const branchScope = workspaceBranchScope(params.workspaceBranch);
  const backend: ContainerBackend = params.containerOptions?.backend ?? "cloudflare_container";
  const fail = (error: string): ScriptRunResult => ({ ok: false, error, tier: 6, actual_tier: 6, engine: "container", duration_ms: Date.now() - started, tokens_used: 0 });
  if (!params.userId || !params.runId || params.userId === "system" || (params.maxTier ?? 6) < 6 || params.signal?.aborted) return fail("container_authorized_actor_run_required");
  if (!opts.authorizeContainer || !await opts.authorizeContainer(params)) return fail("container_execution_denied");
  if (opts.airGappedOnly && backend !== "local_workstation") {
    return { ok: false, error: "compliance_violation: air-gapped execution only permits the authorized local workstation backend", tier: 6, actual_tier: 6, engine: "container", duration_ms: Date.now() - started, tokens_used: 0 };
  }
  if (backend === "webcontainer") {
    if (!opts.webContainer) return unavailableBackend(backend, started);
    const timeoutMs = Math.min(60000, opts.containerTimeoutMs ?? DEFAULT_CONTAINER_TIMEOUT_MS);
    try {
      assertBrowserContainerLease(await opts.browserContainerLease?.(), { tenantId: params.tenantId, spaceId: params.spaceId, ...(params.projectId ? { projectId: params.projectId } : {}),
        actorId: params.userId, agentId: params.agentId, runId: params.runId, executionId: crypto.randomUUID(), timeoutMs, deadline: Date.now() + timeoutMs }, await opts.browserCompatible?.(params) === true);
    } catch (error) { return fail(error instanceof Error ? error.message : "webcontainer_consent_required"); }
    return runContainerRequest(opts.webContainer, opts, params, started);
  }
  if (backend === "local_workstation") {
    if (!params.containerOptions?.localMachineId || !opts.localMachine) return unavailableBackend(backend, started);
    return opts.localMachine(params);
  }

  // §A1.17 Phase L: a script tagged with a Container Marketplace image routes to THAT image's
  // own binding, never the base sandbox — fails closed with a clear message when the image
  // isn't wired yet (every catalogue image ships unavailable today; see container-catalogue.ts).
  if (params.containerImage) {
    if (!opts.resolveSidecar || !params.installationId) return fail("container_active_installation_required");
    try {
      const { namespace, installation, dynamicImage } = await opts.resolveSidecar(params);
      if (installation.installationId !== params.installationId || installation.contract.image !== params.containerImage) return fail("container_image_installation_mismatch");
      const timeoutMs = Math.min(opts.containerTimeoutMs ?? DEFAULT_CONTAINER_TIMEOUT_MS, installation.contract.resources.timeoutSeconds * 1000);
      const scope: ContainerInvocationScope = { tenantId: params.tenantId, spaceId: params.spaceId, ...(params.projectId ? { projectId: params.projectId } : {}), actorId: params.userId,
        agentId: params.agentId, runId: params.runId, executionId: crypto.randomUUID(), installationId: params.installationId,
        ...(installation.scope ? { installationScope: installation.scope } : {}), image: installation.contract.image,
        ...(dynamicImage ? { dynamicImage: true } : {}), timeoutMs, deadline: Date.now() + timeoutMs };
      const stub = namespace.get(namespace.idFromName(sidecarKey(scope) + branchScope));
      return runContainerRequest(stub, opts, params, started, false, scope);
    } catch (error) { return fail(error instanceof Error ? error.message : "container_registry_unavailable"); }
  }

  if (!opts.toolSandbox) {
    return {
      ok: false,
      error:
        "Tier 6 is unavailable: no ToolSandboxDO (TOOL_SANDBOX) binding configured",
      tier: 6,
      actual_tier: 6,
      engine: "container",
      duration_ms: Date.now() - started,
      tokens_used: 0,
    };
  }

  // §A1.17 Phase K: addressed per PROJECT (not per agent) so every thread's agent in the same
  // project shares one container + R2 workspace (spec §33b) — matches workspacePrefix()'s own
  // space/project scoping. "_assistant" is a fixed per-space slot for the Space Assistant
  // (projectId absent), analogous to workspacePrefix()'s space-scoped fallback.
  const doId = opts.toolSandbox.idFromName(
    `sandbox:${params.spaceId}:${params.projectId ?? "_assistant"}${branchScope}`
  );
  const stub = opts.toolSandbox.get(doId);
  if (params.containerOptions?.migration) {
    if (!opts.webContainer) return unavailableBackend("webcontainer", started);
    const terminated = await opts.webContainer.fetch(new Request("http://webcontainer/process/signal", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signal: "SIGTERM", tenantId: params.tenantId, spaceId: params.spaceId, actorId: params.userId, runId: params.runId, previewId: params.containerOptions.migration.previewId }),
    }));
    if (!terminated.ok) return { ok: false, error: `WebContainer SIGTERM failed (${terminated.status})`, tier: 6, actual_tier: 6, engine: "container", duration_ms: Date.now() - started, tokens_used: 0 };
  }
  if (params.containerOptions?.lockfiles) {
    const warmed = await runContainerRequest(stub, opts, { ...params, name: "container.prewarm", code: "", args: {} }, started);
    if (!warmed.ok) return warmed;
    let response: Response;
    try {
      response = await stub.fetch(new Request("http://sandbox/workspace/rehydrate", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ lockfiles: params.containerOptions.lockfiles }), signal: AbortSignal.timeout(2_500),
      }));
    } catch (error) {
      return { ok: false, error: `Lockfile rehydration exceeded 2500ms: ${String(error)}`, tier: 6, actual_tier: 6, engine: "container", duration_ms: Date.now() - started, tokens_used: 0 };
    }
    if (!response.ok) return { ok: false, error: `Lockfile rehydration failed (${response.status})`, tier: 6, actual_tier: 6, engine: "container", duration_ms: Date.now() - started, tokens_used: 0 };
  }
  const result = await runContainerRequest(stub, opts, params, started);
  if (result.ok && params.containerOptions?.migration) {
    result.output = { result: result.output, previewTarget: `https://preview.avos.dev/${encodeURIComponent(params.containerOptions.migration.previewId)}` };
  }
  return result;
}

function unavailableBackend(backend: ContainerBackend, started: number): ScriptRunResult {
  return { ok: false, error: `Tier 6 backend '${backend}' is unavailable`, tier: 6, actual_tier: 6, engine: "container", duration_ms: Date.now() - started, tokens_used: 0 };
}

async function runContainerRequest(
  stub: Pick<DurableObjectStub, "fetch"> | Fetcher,
  opts: CodeRunnerOptions,
  params: Parameters<TieredCodeRunner["run"]>[0],
  started: number,
  localTunnel = false,
  suppliedScope?: ContainerInvocationScope
): Promise<ScriptRunResult> {
  const controller = new AbortController();
  const timeoutMs = Math.min(60000, suppliedScope?.timeoutMs ?? opts.containerTimeoutMs ?? DEFAULT_CONTAINER_TIMEOUT_MS);
  const scope: ContainerInvocationScope = suppliedScope ?? { tenantId: params.tenantId, spaceId: params.spaceId, ...(params.projectId ? { projectId: params.projectId } : {}),
    actorId: params.userId!, agentId: params.agentId, runId: params.runId!, executionId: crypto.randomUUID(), timeoutMs, deadline: Date.now() + timeoutMs };
  validateContainerScope(scope);
  const token = opts.platformSecret ? await mintInternalToken(opts.platformSecret, params.tenantId) : undefined;
  const headers = { "content-type": "application/json", "x-naelao-container-scope": JSON.stringify(scope), ...(token ? { "x-naelao-internal-token": token } : {}) };
  const cancel = () => {
    controller.abort();
    const cancelledScope = { ...scope, timeoutMs: 5000, deadline: Date.now() + 5000 };
    void stub.fetch(new Request("http://sandbox/cancel", { method: "POST", headers: { ...headers, "x-naelao-container-scope": JSON.stringify(cancelledScope) }, body: "{}" })).catch(() => undefined);
  };
  params.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let polling = false, completed = false, lastOutput = "";
  const poll = async () => {
    if (!params.onOutput || polling || completed || controller.signal.aborted) return;
    polling = true;
    try {
      const response = await stub.fetch(new Request("http://sandbox/output", { headers, signal: controller.signal }));
      if (!response.ok) return;
      const output = await response.json<{ stdout?: unknown; stderr?: unknown }>();
      if (typeof output.stdout !== "string" || typeof output.stderr !== "string" || output.stdout.length + output.stderr.length > 2 * 1024 * 1024) return;
      const serialized = JSON.stringify(output);
      if (!completed && !controller.signal.aborted && serialized !== lastOutput) { lastOutput = serialized; params.onOutput({ stdout: output.stdout, stderr: output.stderr }); }
    } catch { /* A progress outage never changes execution or retries a command. */ }
    finally { polling = false; }
  };
  const outputTimer = params.onOutput ? setInterval(() => { void poll(); }, 500) : undefined;
  try {
    if (params.signal?.aborted) { cancel(); throw new Error("container_cancelled"); }
    const computerEndpoint = localTunnel ? "/exec" : params.name === "container.prewarm" ? "/prewarm" : params.name === "computer-use.screenshot"
      ? "/computer/screenshot"
      : params.name === "computer-use.action" ? "/computer/action" : "/exec";
    const resp = await stub.fetch(
      new Request(`http://sandbox${computerEndpoint}`, {
        method: "POST",
        headers: {
          ...headers,
          ...(opts.activeTask && !localTunnel ? { "x-avos-task-active": "1" } : {}),
        },
        body: JSON.stringify(localTunnel ? { op: "exec", params: { command: params.code, args: params.args }, scope } : {
          name: params.name,
          code: params.code,
          args: params.args,
          spaceId: params.spaceId,
          ...(params.projectId ? { projectId: params.projectId } : {}),
          ...(params.workspaceBranch ? { workspaceBranch: params.workspaceBranch } : {}),
        }),
        signal: controller.signal,
      })
    );
    if (computerEndpoint === "/computer/screenshot") {
      if (!resp.ok) return { ok: false, error: `display capture failed (${resp.status})`, tier: 6, actual_tier: 6, engine: "container", duration_ms: Date.now() - started, tokens_used: 0 };
      const bytes = new Uint8Array(await resp.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      return { ok: true, output: { media_type: "image/png", data_base64: btoa(binary), explicit_vision_request: true }, tier: 6, actual_tier: 6, engine: "container", duration_ms: Date.now() - started, tokens_used: 0 };
    }
    const body = await resp.json<{
      ok: boolean;
      result?: unknown;
      error?: string;
      logs?: string;
    }>();
    return {
      ok: resp.ok && body.ok,
      ...(resp.ok && body.ok
        ? { output: body.result === undefined ? body : typeof body.result === "object" && body.result !== null && !Array.isArray(body.result)
          ? { ...body.result, ...("workspace_sync" in body ? { workspace_sync: body.workspace_sync } : {}) } : body.result }
        : { error: `${body.error ?? `container returned ${resp.status}`}${typeof body.logs === "string" && body.logs ? `\n\nFull terminal output:\n${body.logs}` : ""}` }),
      tier: 6,
      actual_tier: 6,
      engine: "container",
      duration_ms: Date.now() - started,
      tokens_used: 0,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      error: aborted
        ? params.signal?.aborted ? "container_cancelled" : "container_deadline_exceeded"
        : String(err instanceof Error ? err.message : err),
      tier: 6,
      actual_tier: 6,
      engine: "container",
      duration_ms: Date.now() - started,
      tokens_used: 0,
    };
  } finally {
    completed = true;
    if (outputTimer !== undefined) clearInterval(outputTimer);
    clearTimeout(timer);
    params.signal?.removeEventListener("abort", cancel);
    if (controller.signal.aborted) cancel();
  }
}

/** Validate and turn a speculative branch into a stable Durable Object namespace suffix. */
function workspaceBranchScope(branch?: string): string {
  if (!branch) return "";
  const normalized = branch.replaceAll("\\", "/");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(normalized) || normalized.includes("..")) {
    throw new Error("workspaceBranch contains an invalid path");
  }
  return `:branch:${normalized}`;
}

/** Builds the TieredCodeRunner the host (NaelaoAgentDO) wires into ScriptEngineEnv.codeRunner. */
export function buildCodeRunner(opts: CodeRunnerOptions): TieredCodeRunner {
  const browserSessions = new Map<string, BrowserRuntimeScope>();
  return {
    async runChannel(params) {
      return runBoundChannelIsolate(opts, {
        name: params.name, code: params.code, tier: 2, args: params.args,
        tenantId: params.tenantId, spaceId: params.spaceId, agentId: params.agentId,
        language: "typescript", signal: params.signal,
        limits: { cpuMs: params.limits?.cpuMs ?? 1_000, wallMs: params.limits?.wallMs ?? 5_000,
          inputBytes: params.limits?.inputBytes ?? 65_536, outputBytes: params.limits?.outputBytes ?? 8_192 },
      }, params.channel, { installationId: params.installationId, maxConcurrency: params.maxConcurrency });
    },
    async run(params) {
      if (params.signal?.aborted) return codeFailure(params, Date.now(), "code_cancelled_or_timed_out");
      if (params.maxTier !== undefined && params.tier > params.maxTier) return codeFailure(params, Date.now(), "execution_ceiling_exceeded");
      if (params.tier === 6) return runContainer(opts, params);
      if (params.tier === 4 || params.tier === 5) {
        if (params.name.startsWith("browser-use.")) {
          return runBrowser(opts, params, params.tier === 4 ? "kitesurf" : "chromium", browserSessions);
        }
        if (params.code && params.code.includes("export async function run")) {
          return runIsolate(opts, params);
        }
        return runBrowser(
          opts,
          params,
          params.tier === 4 ? "kitesurf" : "chromium",
          browserSessions
        );
      }
      if (params.tier === 2 || params.tier === 3) {
        const result = await runIsolate(opts, params);
        const capability = result.capability_error;
        if (capability?.required_tier === 6 && (params.maxTier ?? 2) >= 6 && opts.approveEscalation && await opts.approveEscalation(params, capability.capability ?? capability.code)) {
          return runContainer(opts, { ...params, tier: 6 });
        }
        return result;
      }
      return {
        ok: false,
        error: `Tier ${params.tier} has no codeRunner backend (Tier 1 must be handled in-process)`,
        tier: params.tier,
        duration_ms: 0,
        tokens_used: 0,
      };
    },
  };
}
