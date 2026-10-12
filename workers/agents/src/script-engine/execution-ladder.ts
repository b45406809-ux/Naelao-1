/**
 * The Execution Ladder (spec §8) — routes script.run to the right tier automatically.
 * The agent never picks a tier; it calls script.run(name, params) and the orchestrator
 * routes by the script's declared `requires_tier`.
 *
 *   Tier 1 — SQLite virtual FS           just-bash, Read/Edit and AST operations.
 *   Tier 2 — V8 Isolate (Dynamic Worker) TS/JS + HTTP fetch. No fs, no native bins.
 *   Tier 3 — Durable Workflow            multi-hour jobs and cron execution.
 *   Tier 4 — Kitesurf                     lightweight, scoped DOM observations.
 *   Interactive login/session and visual work explicitly escalate to Tier 5 within
 *   the run's ceiling. Receipts report the actual engine; failed mutations never retry
 *   on a second engine. Browser observation and image loading are separate commands.
 *   Tier 5 — Chromium                    visual/full-browser rendering.
 *   Tier 6 — Container (SandboxDO)       Full Linux, Python/bash and native compilers.
 *   General runtimes are project-scoped; extension binaries run in approved, digest-pinned
 *   task sidecars. WebContainers require a live consenting browser and declared compatibility.
 *   Neither a native incompatibility nor a browser disconnect permits a policy bypass.
 *
 * Tiers 2-5 execute arbitrary stored code and so are delegated to an injected
 * TieredCodeRunner (the concrete mechanism — Dynamic Worker Loader, browser proxy,
 * SandboxDO — lives in the host worker, not here). Tier 1 is implemented directly because
 * it is pure R2 and must always work even with no runner wired.
 */

import { executeVirtualShell } from "./r2-workspace.js";
import type {
  ExecutionTier,
  ScriptEngineEnv,
  ScriptRunResult,
  StoredScript,
} from "./types.js";
import type { FastDecisionGateway } from "@naelao/agent-sdk";
import { parseShell } from "./shell-parser.js";

export const EXECUTION_ENGINES = {
  1: "sqlite_fs",
  2: "isolate",
  3: "workflow",
  4: "kitesurf",
  5: "chromium",
  6: "container",
} as const satisfies Record<ExecutionTier, string>;

export type ExecutionEngine = (typeof EXECUTION_ENGINES)[ExecutionTier];

const NATIVE_COMMANDS = /(?:^|[;&|]\s*|\s)(?:cargo(?:\s+build|\s+test)?|rustc|gcc|g\+\+|clang|clang\+\+|cmake|make|docker|podman|apt(?:-get)?|apk|yum|dnf)(?:\s|$)/i;
const NATIVE_PACKAGES = /(?:@tensorflow\/tfjs-node|node-gyp|sharp|better-sqlite3|canvas|bcrypt|torch|tensorflow|opencv|cv2|scipy|numpy|pandas)/i;
const HEAVY_PYTHON_IMPORT = /^\s*(?:from|import)\s+(?:torch|tensorflow|cv2|opencv|scipy|numpy|pandas|sklearn|jax|xgboost)\b/m;
const NATIVE_BINARIES = new Set(["bash", "sh", "node", "npm", "pnpm", "yarn", "git", "python", "python3", "pip", "pip3", "cargo", "rustc", "gcc", "g++", "clang", "clang++", "cmake", "make", "docker", "podman", "apt", "apt-get", "apk", "yum", "dnf"]);
export function isDeclaredNativeCommand(name: string): boolean { return NATIVE_BINARIES.has(name); }

/** Deterministic native pre-flight. It remains the fail-closed authority if System One is absent. */
export function requiresNativeCompilation(command: string): boolean {
  return NATIVE_COMMANDS.test(command) ||
    (/\b(?:npm|pnpm|yarn|pip3?|python3?\s+-m\s+pip)\s+(?:i|install|add|rebuild)\b/i.test(command) && NATIVE_PACKAGES.test(command)) ||
    HEAVY_PYTHON_IMPORT.test(command) ||
    (/\bpython3?\s+-c\b/i.test(command) && /\b(?:import|from)\s+(?:torch|tensorflow|cv2|opencv|scipy|numpy|pandas|sklearn|jax|xgboost)\b/i.test(command));
}

/** Classifies ordinary shell intent without revealing tier mechanics to the model. */
export function classifyExecutionRoute(command: string): { tier: ExecutionTier; engine: ExecutionEngine; reason: string } {
  const local = new Set(["cat", "head", "tail", "grep", "sed", "awk", "find", "jq", "diff", "sort", "uniq", "wc", "pwd", "echo", "printf", "ls", "true", "false", "touch", "rm", "cp", "mv", "naelao"]);
  let selected: { tier: ExecutionTier; reason: string } = { tier: 1, reason: "virtual_posix" };
  for (const { argv } of parseShell(command).flatMap((pipeline) => pipeline.commands)) {
    const name = argv[0];
    if (!name) continue;
    let route: typeof selected;
    if (local.has(name)) route = { tier: 1, reason: "virtual_posix" };
    else if (name === "workflow" || name === "schedule") route = { tier: 3, reason: "durable_workflow" };
    else if (name === "browse") route = argv.some((arg) => ["--screenshot", "--pdf", "--visual"].includes(arg)) ? { tier: 5, reason: "visual_browser" } : { tier: 4, reason: "dom_browser" };
    else if (name === "see") route = { tier: 5, reason: "on_demand_vision" };
    else if (isDeclaredNativeCommand(name)) route = { tier: 6, reason: "declared_native_command" };
    else if (["stripe", "gh", "r2", "resend", "twilio"].includes(name) || /^(ext|auto):/.test(name)) route = { tier: 2, reason: "registered_capability" };
    else return { tier: 1, engine: EXECUTION_ENGINES[1], reason: "command_not_found" };
    if (route.tier > selected.tier) selected = route;
  }
  return { ...selected, engine: EXECUTION_ENGINES[selected.tier] };
}

/**
 * Refine an execution route with Jev or Laya before any isolate is created. The sentry may only
 * elevate to the Linux container; it can never downgrade a route selected by deterministic policy.
 */
export async function classifyExecutionRouteWithSentry(
  command: string,
  sentry?: Pick<FastDecisionGateway, "noul">
): Promise<{ tier: ExecutionTier; engine: ExecutionEngine; reason: string; sentry?: { provider: "jev" | "laya" | "clef"; confidence?: number; model?: string } }> {
  const baseline = classifyExecutionRoute(command);
  if (!sentry || baseline.tier === 6 || baseline.reason === "command_not_found" || baseline.tier === 1) return baseline;
  try {
    const decision = await sentry.noul({
      state: { command },
      instructions: "Does this shell command require native operating-system packages, compiled binaries, native build tools, or a full Linux environment that cannot run in a V8 isolate or Pyodide?",
      criteria: {
        true: "Requires native compilation, native dependencies, system packages, privileged OS behavior, or a full Linux process environment.",
        false: "Can run with virtual filesystem commands, JavaScript in V8, pure Python in Pyodide, a workflow, or a browser service.",
      },
      policyCode: "execution_native_preflight_v1",
      // Ambiguous predictions must preserve the deterministic route rather than spending a
      // container allocation. Native commands already caught by regex never depend on this gate.
      threshold: 0.75,
    });
    if (!decision.value || decision.provider === "deterministic") return baseline;
    return {
      tier: 6,
      engine: EXECUTION_ENGINES[6],
      reason: `${decision.provider}_native_preflight`,
      sentry: { provider: decision.provider, ...(decision.confidence !== undefined ? { confidence: decision.confidence } : {}), ...(decision.model ? { model: decision.model } : {}) },
    };
  } catch {
    return baseline;
  }
}

/** Run a stored script (agent-distilled / authored code) at its declared tier. */
export async function runStoredScript(
  env: ScriptEngineEnv,
  script: StoredScript,
  args: Record<string, unknown>
): Promise<ScriptRunResult> {
  const tier = script.metadata.requires_tier;
  const started = Date.now();

  if (!script.code) {
    return {
      ok: false,
      error: `Script ${script.metadata.name} has no code to execute`,
      tier,
      duration_ms: Date.now() - started,
      tokens_used: 0,
    };
  }

  if (tier === 1) {
    const op =
      (args["op"] as "read" | "write" | "delete" | "list" | "grep") || "read";
    const result = await executeVirtualShell(env, op, args);
    return { ...result, actual_tier: 1, engine: "sqlite_fs" };
  }

  // §A1.17 Phase J: a script tagged runtime:"workflow" dispatches to a durable CF Workflow
  // instance instead of running synchronously here — for long-running/cron automations that
  // must survive restarts or run for hours/days without holding an isolate or this DO awake.
  // Orthogonal to tier (which still governs what the eventual execution may do).
  if (script.metadata.runtime === "workflow") {
    if (!env.workflowRunner) {
      return {
        ok: false,
        error: `Script '${script.metadata.name}' is marked runtime:"workflow" but no workflow runner is wired in this environment`,
        tier,
        actual_tier: 3,
        engine: "workflow",
        duration_ms: Date.now() - started,
        tokens_used: 0,
      };
    }
    try {
      const { id } = await env.workflowRunner.start({
        name: script.metadata.name,
        args,
        spaceId: env.spaceId,
        agentId: env.agentId,
        tenantId: env.tenantId,
        ...(env.projectId ? { projectId: env.projectId } : {}),
        ...(env.airGappedOnly ? { airGappedOnly: true } : {}),
      });
      return {
        ok: true,
        output: { workflow_id: id, status: "started" },
        tier,
        actual_tier: 3,
        engine: "workflow",
        duration_ms: Date.now() - started,
        tokens_used: 0,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        tier,
        actual_tier: 3,
        engine: "workflow",
        duration_ms: Date.now() - started,
        tokens_used: 0,
      };
    }
  }

  // Tiers 2-5: delegate to the injected runner.
  if (!env.codeRunner) {
    return {
      ok: false,
      error: `Execution tier ${tier} is unavailable in this environment (no code runner wired)`,
      tier,
      duration_ms: Date.now() - started,
      tokens_used: 0,
    };
  }

  try {
    return await env.codeRunner.run({
      name: script.metadata.name,
      code: script.code,
      tier,
      args,
      spaceId: env.spaceId,
      agentId: env.agentId,
      tenantId: env.tenantId,
      ...(env.maxTier !== undefined ? { maxTier: env.maxTier } : {}),
      ...(script.metadata.code_capabilities ? { capabilities: script.metadata.code_capabilities } : {}),
      ...(script.metadata.code_language ? { language: script.metadata.code_language } : {}),
      ...(env.runId ? { runId: env.runId } : {}),
      ...(env.taskId ? { taskId: env.taskId } : {}),
      ...(env.humanInvokerId ? { userId: env.humanInvokerId } : {}),
      ...(env.executionSignal ? { signal: env.executionSignal } : {}),
      ...(env.projectId ? { projectId: env.projectId } : {}),
      ...(env.workspaceBranch ? { workspaceBranch: env.workspaceBranch } : {}),
      ...(script.metadata.container_image
        ? { containerImage: script.metadata.container_image }
        : {}),
      ...(script.metadata.container_installation_id ? { installationId: script.metadata.container_installation_id } : {}),
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      tier,
      duration_ms: Date.now() - started,
      tokens_used: 0,
    };
  }
}

/** Human-readable tier description (for logs/observability). */
export function tierLabel(tier: ExecutionTier): string {
  return (
    {
      1: "T1 direct-vfs",
      2: "T2 v8-isolate",
      3: "T3 workflow",
      4: "T4 kitesurf-browser",
      5: "T5 chromium-browser",
      6: "T6 container-sandbox",
    } as const
  )[tier];
}
