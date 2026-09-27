/**
 * The Execution Ladder (spec §8) — routes script.run to the right tier automatically.
 * The agent never picks a tier; it calls script.run(name, params) and the orchestrator
 * routes by the script's declared `requires_tier`.
 *
 *   Tier 1 — SQLite virtual FS           just-bash, Read/Edit and AST operations.
 *   Tier 2 — V8 Isolate (Dynamic Worker) TS/JS + HTTP fetch. No fs, no native bins.
 *   Tier 3 — Durable Workflow            multi-hour jobs and cron execution.
 *   Tier 4 — Browser (CF Browser)        DOM/click/fill/screenshot via naelao-browser proxy.
 *                                        naelao-browser itself tries Kitesurf FIRST (a
 *                                        lightweight, agent-first browser Cloudflare announced
 *                                        2026-08-06 — 3-7x less CPU/memory than Chromium, ~1.7x
 *                                        slower wall time, real per @cloudflare/puppeteer 1.3.0's
 *                                        `WorkersLaunchOptions.browser: 'kitesurf'`) and falls
 *                                        back to Chromium on any failure — an internal detail of
 *                                        Tier 4, not a 6th tier, since it changes cost/reliability
 *                                        but not capability. Known Kitesurf gaps (still beta, no
 *                                        GA date): video playback, WebGL, bot-challenge/TLS-
 *                                        fingerprint handshakes, persistent authenticated
 *                                        sessions, pixel-perfect rendering — a caller that knows a
 *                                        target needs one of those can force `engine: "chromium"`.
 *   Tier 5 — Chromium                    visual/full-browser rendering.
 *   Tier 6 — Container (SandboxDO)       Full Linux, Python/bash and native compilers.
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

/** Jev-style deterministic pre-flight. It runs before any isolate is created. */
export function requiresNativeCompilation(command: string): boolean {
  return NATIVE_COMMANDS.test(command) ||
    (/\b(?:npm|pnpm|yarn|pip3?|python3?\s+-m\s+pip)\s+(?:i|install|add|rebuild)\b/i.test(command) && NATIVE_PACKAGES.test(command)) ||
    HEAVY_PYTHON_IMPORT.test(command) ||
    (/\bpython3?\s+-c\b/i.test(command) && /\b(?:import|from)\s+(?:torch|tensorflow|cv2|opencv|scipy|numpy|pandas|sklearn|jax|xgboost)\b/i.test(command));
}

/** Classifies ordinary shell intent without revealing tier mechanics to the model. */
export function classifyExecutionRoute(command: string): { tier: ExecutionTier; engine: ExecutionEngine; reason: string } {
  const value = command.trim();
  let tier: ExecutionTier;
  let reason: string;
  if (requiresNativeCompilation(value)) { tier = 6; reason = "jev_native_preflight"; }
  else if (/^(?:workflow\s+run|schedule\s+--cron)\b/.test(value)) { tier = 3; reason = "durable_workflow"; }
  else if (/^(?:browse)\b/.test(value)) { tier = /(?:--screenshot|--pdf|--visual|webgl|canvas)/i.test(value) ? 5 : 4; reason = tier === 5 ? "visual_browser" : "dom_browser"; }
  else if (/^(?:see)\b/.test(value)) { tier = 5; reason = "on_demand_vision"; }
  else if (/^(?:cat|head|tail|grep|rg|sed|awk|find|jq|diff|sort|uniq|wc|pwd|echo|printf|test|\[|Read|Edit)\b/.test(value)) { tier = 1; reason = "virtual_posix"; }
  else if (/^(?:node|tsx?|deno|python3?|stripe|gh|r2|resend|twilio|ext:|auto:|avos\s+chore)\b/.test(value)) { tier = 2; reason = "isolate_runtime"; }
  else { tier = 6; reason = "linux_command"; }
  return { tier, engine: EXECUTION_ENGINES[tier], reason };
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
      ...(env.humanInvokerId ? { userId: env.humanInvokerId } : {}),
      ...(env.projectId ? { projectId: env.projectId } : {}),
      ...(script.metadata.container_image
        ? { containerImage: script.metadata.container_image }
        : {}),
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
