/**
 * The Execution Ladder (spec §8) — routes script.run to the right tier automatically.
 * The agent never picks a tier; it calls script.run(name, params) and the orchestrator
 * routes by the script's declared `requires_tier`.
 *
 *   Tier 1 — Direct R2 (Workspace)      ~0ms boot. File ops only. Handled in-process.
 *   Tier 2 — V8 Isolate (Dynamic Worker) TS/JS + HTTP fetch. No fs, no native bins.
 *   Tier 3 — npm (Dynamic Worker + pkg)  Tier 2 + npm package resolution.
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
 *   Tier 5 — Container (SandboxDO)        Full Linux, Python/bash, native bins, multi-container.
 *
 * Tiers 2-5 execute arbitrary stored code and so are delegated to an injected
 * TieredCodeRunner (the concrete mechanism — Dynamic Worker Loader, browser proxy,
 * SandboxDO — lives in the host worker, not here). Tier 1 is implemented directly because
 * it is pure R2 and must always work even with no runner wired.
 */

import type { ExecutionTier, HypervisorRouteResult, ScriptEngineEnv, ScriptRunResult, StoredScript } from "./types.js";
import { executeBrowserTool } from "./prebuilt/browser-use.js";

/**
 * List of heavy native build, compilation, and system binaries that
 * MUST run inside a Tier 6 Linux Container sandbox.
 */
export const TIER_6_CONTAINER_BINARIES = new Set([
  "npm",
  "pnpm",
  "yarn",
  "cargo",
  "rustc",
  "gcc",
  "g++",
  "make",
  "cmake",
  "docker",
  "pip",
  "python",
  "python3",
  "go",
  "swift",
  "javac",
  "java",
  "dotnet",
]);

/**
 * Detects if a Python script imports native C-extensions that require
 * a full Linux kernel / Docker container.
 */
export function requiresNativeCExtensions(script: string): boolean {
  const nativeLibs = ["torch", "cv2", "tensorflow", "scipy_c", "libraw", "cuda", "pyautogui"];
  return nativeLibs.some((lib) => script.includes(`import ${lib}`) || script.includes(`from ${lib}`));
}

/**
 * Inspects a terminal command string and resolves the optimal execution tier,
 * targeting the cheapest and fastest compute primitive on Cloudflare.
 */
export function resolveExecutionTier(command: string): HypervisorRouteResult {
  const trimmed = command.trim();
  const parts = trimmed.split(/\s+/);
  const binary = parts[0] || "";
  const subCommand = parts[1] || "";
  const fullCommandPrefix = `${binary} ${subCommand}`.trim();

  // 1. Check for Heavy Tier 6 Container Compilation / Native Commands
  if (
    TIER_6_CONTAINER_BINARIES.has(binary) ||
    trimmed.startsWith("npm run") ||
    trimmed.startsWith("npm install") ||
    trimmed.startsWith("pip install") ||
    trimmed.startsWith("cargo build") ||
    trimmed.startsWith("go build")
  ) {
    // Exception: Lightweight in-isolate Pyodide python executions without native C-extensions
    if ((binary === "python" || binary === "python3") && !requiresNativeCExtensions(trimmed)) {
      return {
        tier: 2,
        binary,
        args: parts.slice(1),
        requiresContainer: false,
        requiresBrowser: false,
        requiresWorkflow: false,
        suggestedBackend: "v8_isolate",
      };
    }

    return {
      tier: 6,
      binary,
      args: parts.slice(1),
      requiresContainer: true,
      requiresBrowser: false,
      requiresWorkflow: false,
      suggestedBackend: "container",
    };
  }

  // 2. Check for Tier 4 & Tier 5 Browser Navigation Commands
  if (binary === "browse" || binary === "scrape" || binary === "kitesurf" || binary === "puppeteer") {
    const isVisualQa =
      trimmed.includes("--screenshot") || trimmed.includes("--webgl") || trimmed.includes("--canvas") || trimmed.includes("--visual");
    const tier: ExecutionTier = isVisualQa ? 5 : 4;
    return {
      tier,
      binary,
      args: parts.slice(1),
      requiresContainer: false,
      requiresBrowser: true,
      requiresWorkflow: false,
      suggestedBackend: isVisualQa ? "chromium" : "kitesurf",
    };
  }

  // 3. Check for Tier 3 Dynamic Workflows & Cron Schedulers
  if (binary === "schedule" || binary === "workflow" || binary === "cron") {
    return {
      tier: 3,
      binary,
      args: parts.slice(1),
      requiresContainer: false,
      requiresBrowser: false,
      requiresWorkflow: true,
      suggestedBackend: "workflow",
    };
  }

  // 4. Default: Tier 1/2 In-Memory V8 Isolate / Virtual POSIX Shell (just-bash)
  return {
    tier: 2,
    binary,
    args: parts.slice(1),
    requiresContainer: false,
    requiresBrowser: false,
    requiresWorkflow: false,
    suggestedBackend: "v8_isolate",
  };
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
    // Tier 1 stored scripts are rare (most T1 work is a prebuilt op), but a stored T1
    // script is a pure R2 transform. We do not eval arbitrary code in the DO isolate for
    // safety; a T1 stored script must be expressed through prebuilt r2-workspace ops, so
    // reaching here means the script was mis-tiered.
    return {
      ok: false,
      error:
        `Tier 1 stored-code execution is not supported in-process; express file work as ` +
        `prebuilt r2-workspace ops or raise requires_tier to 2.`,
      tier,
      duration_ms: Date.now() - started,
      tokens_used: 0,
    };
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
        duration_ms: Date.now() - started,
        tokens_used: 0,
      };
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
      ...(env.projectId ? { projectId: env.projectId } : {}),
      ...(script.metadata.container_image ? { containerImage: script.metadata.container_image } : {}),
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
  const labels: Record<ExecutionTier, string> = {
    1: "T1 direct-R2",
    2: "T2 v8-isolate",
    3: "T3 workflow",
    4: "T4 browser-kitesurf",
    5: "T5 browser-chromium",
    6: "T6 container-sandbox",
  };
  return labels[tier] ?? `T${tier}`;
}
