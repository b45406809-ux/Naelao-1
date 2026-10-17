import { redactCodeValue } from "@naelao/agent-sdk";
import { compileDynamicCode, buildGuestHarness, buildChannelGuestHarness, buildPythonHarness, ISOLATE_POLICY_MODULE } from "./dynamic-code.js";
import type { CodeRunnerOptions, WorkerLoaderModuleConfig, WorkerLoaderStub } from "./code-runner.js";
import type { CodeRpcBinding } from "./code-rpc-broker.js";
import type { ExecutionTier, ScriptRunResult, TieredCodeRunner } from "./types.js";

export type CodeRunParams = Parameters<TieredCodeRunner["run"]>[0];
const activeByTenant = new Map<string, number>();
const activeByChannelInstallation = new Map<string, number>();
let activeIsolates = 0;
export function codeFailure(params: CodeRunParams, started: number, code: string, capability?: string, requiredTier?: ExecutionTier): ScriptRunResult {
  return { ok: false, error: code, tier: params.tier, actual_tier: params.tier, engine: "isolate",
    duration_ms: Date.now() - started, tokens_used: 0,
    capability_error: { code, ...(capability ? { capability } : {}), ...(requiredTier ? { required_tier: requiredTier } : {}) } };
}
function bounded(value: number | undefined, fallback: number, maximum: number): number {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error("code_invalid_limit");
  return Math.min(maximum, Math.max(1, Math.floor(value ?? fallback)));
}
async function readBoundedResponse(response: Response, max: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let bytes = 0, body = "";
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > max) { await reader.cancel(); throw new Error("code_output_limit"); }
      body += decoder.decode(chunk.value, { stream: true });
    }
    return body + decoder.decode();
  } finally { reader.releaseLock(); }
}
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("code_cancelled_or_timed_out"));
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new Error("code_cancelled_or_timed_out"));
    signal.addEventListener("abort", stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}
function disposeStub(value: unknown): void {
  const symbol = (Symbol as unknown as { dispose?: symbol }).dispose;
  if (!symbol || !value) return;
  const dispose = (value as Record<symbol, unknown>)[symbol];
  if (typeof dispose === "function") dispose.call(value);
}

export async function runIsolate(opts: CodeRunnerOptions, params: CodeRunParams): Promise<ScriptRunResult> {
  return runIsolateInternal(opts, params);
}

type ChannelRuntimeContext = NonNullable<Parameters<NonNullable<TieredCodeRunner["runChannel"]>>[0]["channel"]>;
export async function runBoundChannelIsolate(opts: CodeRunnerOptions, params: CodeRunParams, channel: ChannelRuntimeContext,
  channelLimit: { installationId: string; maxConcurrency: number }): Promise<ScriptRunResult> {
  return runIsolateInternal(opts, params, channel, channelLimit);
}

async function runIsolateInternal(opts: CodeRunnerOptions, params: CodeRunParams, channel?: ChannelRuntimeContext,
  channelLimit?: { installationId: string; maxConcurrency: number }): Promise<ScriptRunResult> {
  const started = Date.now(), executionId = crypto.randomUUID();
  if (!opts.loader) return codeFailure(params, started, "worker_loader_unavailable");
  if (!params.tenantId || !params.spaceId || !params.agentId) return codeFailure(params, started, "code_scope_required");
  if (channel && (!channelLimit?.installationId || !Number.isInteger(channelLimit.maxConcurrency) || channelLimit.maxConcurrency < 1)) return codeFailure(params, started, "channel_handler_concurrency_limit");
  const channelKey = channel && channelLimit ? `${params.tenantId}:${params.spaceId}:${channelLimit.installationId}` : "";
  if (channel && channelKey && (activeByChannelInstallation.get(channelKey) ?? 0) >= channelLimit!.maxConcurrency) return codeFailure(params, started, "channel_handler_concurrency_limit");
  const python = params.language === "python" || params.name === "code-exec.execute_python";
  if (python && !opts.pythonEnabled) return codeFailure(params, started, "python_wasm_unavailable", "python_workers");
  if (python && opts.airGappedOnly) return codeFailure(params, started, "authorized_local_python_required", "local-python", 6);
  const tenantCount = activeByTenant.get(params.tenantId) ?? 0;
  if (activeIsolates >= (opts.maxConcurrentIsolates ?? 16) || tenantCount >= (opts.maxConcurrentPerTenant ?? 4))
    return codeFailure(params, started, "code_loader_concurrency_limit");
  // Reserve before any await; simultaneous compilation cannot overbook loader slots.
  activeIsolates++; activeByTenant.set(params.tenantId, tenantCount + 1);
  if (channel && channelKey) activeByChannelInstallation.set(channelKey, (activeByChannelInstallation.get(channelKey) ?? 0) + 1);
  const controller = new AbortController(), cancel = () => controller.abort();
  params.signal?.addEventListener("abort", cancel, { once: true });
  if (params.signal?.aborted) cancel();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rpc: { binding: CodeRpcBinding; close(): void } | undefined;
  let stub: WorkerLoaderStub | undefined, entrypoint: Fetcher | undefined, digest: string | undefined;
  let outputBytes = 65_536, memoryMb = 128;
  try {
    const limits = {
      cpuMs: bounded(params.limits?.cpuMs, 1_000, 30_000),
      wallMs: bounded(params.limits?.wallMs, opts.isolateTimeoutMs ?? 15_000, 120_000),
      inputBytes: bounded(params.limits?.inputBytes, 262_144, 1_048_576),
      outputBytes: bounded(params.limits?.outputBytes, 65_536, 1_048_576),
    };
    outputBytes = limits.outputBytes; memoryMb = opts.isolateMemoryMb ?? 128;
    if (params.limits?.memoryMb !== undefined && params.limits.memoryMb < memoryMb)
      return codeFailure(params, started, "isolate_memory_quota_unsupported", "custom-memory-limit");
    const deadline = Date.now() + limits.wallMs;
    timer = setTimeout(cancel, limits.wallMs);
    if (channel && (python || (params.capabilities?.length ?? 0) > 0)) return codeFailure(params, started, "channel_handler_capability_forbidden");
    if (channel && new TextEncoder().encode(JSON.stringify(channel)).byteLength > 32_768) return codeFailure(params, started, "channel_event_limit");
    const requestBody = JSON.stringify({ args: python ? { ...params.args, code: String(params.args["code"] ?? params.code) } : params.args,
      ...(channel ? { channel } : {}) });
    if (new TextEncoder().encode(requestBody).byteLength > limits.inputBytes) return codeFailure(params, started, "code_input_limit");
    if ((params.dependencies?.length ?? 0) > 16) return codeFailure(params, started, "code_dependency_limit");
    // No unsigned dependency or package-CDN resolution. Provider stdlib is available to Python.
    if (params.dependencies?.length || python && Array.isArray(params.args["install_deps"]) && params.args["install_deps"].length)
      return codeFailure(params, started, "pinned_dependency_artifact_unavailable", "package-artifact", 6);
    const modules: WorkerLoaderModuleConfig["modules"] = {};
    if (python) {
      const code = String(params.args["code"] ?? params.code);
      if (new TextEncoder().encode(code).byteLength > 262_144) return codeFailure(params, started, "code_source_limit");
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("python-v1:" + code));
      digest = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
      modules["main.py"] = { py: buildPythonHarness(outputBytes) };
    } else {
      const compiled = await compileDynamicCode(params.code, params.language === "javascript" ? "javascript" : "typescript");
      digest = compiled.digest; modules["policy.js"] = ISOLATE_POLICY_MODULE;
      modules["guest.js"] = compiled.javascript; modules["main.js"] = channel ? buildChannelGuestHarness(outputBytes) : buildGuestHarness(outputBytes);
    }
    const capabilities = params.capabilities ?? [];
    if (python && capabilities.length) return codeFailure(params, started, "python_rpc_adapter_unavailable");
    const env: Record<string, unknown> = channel ? {} : { __SPACE_ID__: params.spaceId, ...(params.projectId ? { __PROJECT_ID__: params.projectId } : {}) };
    if (capabilities.length) {
      if (!opts.createRpcBinding || !opts.authorizeCodeCapability || !opts.dispatchCodeCapability) return codeFailure(params, started, "code_rpc_binding_unavailable");
      rpc = await opts.createRpcBinding({
        scope: { tenantId: params.tenantId, spaceId: params.spaceId, agentId: params.agentId,
          ...(params.projectId ? { projectId: params.projectId } : {}), ...(params.userId ? { userId: params.userId } : {}),
          ...(params.runId ? { runId: params.runId } : {}), ...(params.taskId ? { taskId: params.taskId } : {}),
          ...(params.installationId ? { installationId: params.installationId } : {}), ...(params.grantVersion ? { grantVersion: params.grantVersion } : {}) },
        capabilities, signal: controller.signal, maxCalls: 64, maxPayloadBytes: outputBytes,
        secrets: opts.platformSecret ? [opts.platformSecret] : [],
        authorize: opts.authorizeCodeCapability, dispatch: opts.dispatchCodeCapability,
      }, deadline);
      env.__RPC__ = rpc.binding;
    }
    if (controller.signal.aborted) throw new Error("code_cancelled_or_timed_out");
    const config: WorkerLoaderModuleConfig = {
      compatibilityDate: "2026-09-10", ...(python ? { compatibilityFlags: ["python_workers"] } : {}),
      mainModule: python ? "main.py" : "main.js", modules, env, globalOutbound: null,
      limits: { cpuMs: limits.cpuMs, subRequests: 64 },
    };
    // Fresh execution globals. Cache only the immutable compiled artifact.
    stub = opts.loader.load ? opts.loader.load(config) : opts.loader.get(params.tenantId + ":" + params.spaceId + ":" + executionId, () => config);
    entrypoint = stub.getEntrypoint();
    const response = await raceAbort(entrypoint.fetch(new Request("http://script/run", {
      method: "POST", headers: { "content-type": "application/json" }, body: requestBody, signal: controller.signal,
    })), controller.signal);
    const body = JSON.parse(await raceAbort(readBoundedResponse(response, outputBytes + 4096), controller.signal)) as {
      ok?: boolean; result?: unknown; error?: string; capability_error?: ScriptRunResult["capability_error"]; replies?: string[]; answerRequests?: string[]; sessionUpdate?: unknown; sessionUpdates?: Array<{ sessionId: string; value: unknown }>;
    };
    return { ok: response.ok && body.ok === true,
      ...(response.ok && body.ok ? { output: redactCodeValue(body.result, outputBytes, opts.platformSecret ? [opts.platformSecret] : []) } : { error: redactCodeValue(body.error ?? "isolate_http_" + response.status, outputBytes, opts.platformSecret ? [opts.platformSecret] : []) as string }),
      ...(body.capability_error ? { capability_error: body.capability_error } : {}),
      ...(channel && Array.isArray(body.replies) && body.replies.length <= 1 && body.replies.every(reply => typeof reply === "string" && reply.length <= 2000) ? { channel_replies: body.replies } : {}),
      ...(channel && Array.isArray(body.answerRequests) && body.answerRequests.length <= 1 && body.answerRequests.every(question => typeof question === "string" && question.length <= 2_000) ? { channel_answers: body.answerRequests } : {}),
      ...(channel && Object.hasOwn(body, "sessionUpdate") ? { channel_session_update: body.sessionUpdate } : {}),
      ...(channel && Array.isArray(body.sessionUpdates) && body.sessionUpdates.length <= 16 && body.sessionUpdates.every(update => update && typeof update.sessionId === "string" && /^[a-z][a-z0-9_-]{0,47}$/.test(update.sessionId)) ? { channel_session_updates: body.sessionUpdates } : {}),
      tier: params.tier, actual_tier: params.tier, engine: "isolate", duration_ms: Date.now() - started, tokens_used: 0,
      runtime_receipt: { execution_id: executionId, code_digest: digest, backend: python ? "python-wasm" : "dynamic-worker", wall_ms: Date.now() - started, memory_limit_mb: memoryMb,
        output_bytes: body.ok ? new TextEncoder().encode(JSON.stringify(body.result ?? null)).byteLength : 0, cost_source: "unreported" },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failure = codeFailure(params, started, controller.signal.aborted ? "code_cancelled_or_timed_out" : message);
    failure.runtime_receipt = { execution_id: executionId, ...(digest ? { code_digest: digest } : {}), backend: python ? "python-wasm" : "dynamic-worker", wall_ms: Date.now() - started, memory_limit_mb: memoryMb, cost_source: "unreported" };
    return failure;
  } finally {
    controller.abort(); rpc?.close();
    if (timer !== undefined) clearTimeout(timer);
    params.signal?.removeEventListener("abort", cancel);
    disposeStub(entrypoint); disposeStub(stub);
    activeIsolates--; const remaining = (activeByTenant.get(params.tenantId) ?? 1) - 1;
    if (remaining) activeByTenant.set(params.tenantId, remaining); else activeByTenant.delete(params.tenantId);
    if (channel && channelKey) { const channelRemaining = (activeByChannelInstallation.get(channelKey) ?? 1) - 1; if (channelRemaining) activeByChannelInstallation.set(channelKey, channelRemaining); else activeByChannelInstallation.delete(channelKey); }
  }
}
