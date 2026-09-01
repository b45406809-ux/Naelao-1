/**
 * The Execution Ladder (spec §8) — routes script.run to the right tier automatically.
 * The agent never picks a tier; it calls script.run(name, params) and the orchestrator
 * routes by the script's declared `requires_tier`.
 *
 *   Tier 1 — Direct In-Memory Virtual FS (@cloudflare/computer / DO SQLite / R2) ~0ms boot.
 *   Tier 2 — Dynamic Worker Loader (V8 Isolate Shell / TS Script) TS/JS + HTTP fetch + MCP.
 *   Tier 3 — Dynamic Workflows (Cloudflare Workflows / Cron Hub) Durable multi-step runs, sleep, retries.
 *   Tier 4 — Lightweight Agent Browser (Cloudflare Kitesurf) DOM text extraction & form fills (3-7x cheaper/faster).
 *   Tier 5 — Full Headless Chromium (Puppeteer / Browser Render) Visual QA snapshots, WebGL, Canvas, bot defense.
 *   Tier 6 — Sandboxed Linux Container (ToolSandboxDO / Ubuntu) Full OS userland, npm install, compilers, Python.
 *
 * Tiers 2-6 execute arbitrary stored code and so are delegated to an injected
 * TieredCodeRunner or workflowRunner. Tier 1 is implemented directly in-process.
 */

import type { ExecutionTier, ScriptEngineEnv, ScriptRunResult, StoredScript } from "./types.js";
import type { ComputeLadderTierDefinition } from "@naelao/types";

export const COMPUTE_LADDER_TIERS: Record<ExecutionTier, ComputeLadderTierDefinition> = {
  1: {
    tier: 1,
    code: "VIRTUAL_FS",
    name: "Tier 1: Direct In-Memory Virtual FS",
    description: "Sub-millisecond AST Search & Replace, regex search, line-numbered file reading, and atomic CAS patching in DO SQLite",
    typicalColdStartMs: 0,
    costWeight: 0.1,
    capabilities: ["read_file", "edit_file", "patch_ast", "grep", "glob", "just_bash"],
  },
  2: {
    tier: 2,
    code: "V8_ISOLATE",
    name: "Tier 2: Dynamic Worker Loader / Isolate CodeMode",
    description: "Pure TypeScript / JavaScript execution with fetch() and Model Context Protocol (MCP) tool orchestration",
    typicalColdStartMs: 4,
    costWeight: 1.0,
    capabilities: ["typescript_exec", "fetch_api", "mcp_client", "json_transform"],
  },
  3: {
    tier: 3,
    code: "DYNAMIC_WORKFLOW",
    name: "Tier 3: Dynamic Workflows",
    description: "Durable multi-step state chains, multi-hour/day executions, sleep/pause checkpointing, and scheduled cron jobs",
    typicalColdStartMs: 25,
    costWeight: 1.5,
    capabilities: ["durable_step", "sleep_until", "step_retry", "cron_hub"],
  },
  4: {
    tier: 4,
    code: "KITESURF_BROWSER",
    name: "Tier 4: Lightweight Agent Browser (Kitesurf)",
    description: "3-7x faster & cheaper headless DOM text extraction, link crawling, and form fills without heavy graphics engine overhead",
    typicalColdStartMs: 60,
    costWeight: 2.0,
    capabilities: ["dom_extract", "text_crawl", "form_fill", "fast_navigate"],
  },
  5: {
    tier: 5,
    code: "PUPPETEER_CHROMIUM",
    name: "Tier 5: Full Headless Chromium",
    description: "Full graphics engine for Visual QA snapshots, WebGL canvas rendering, PDF generation, and bot-defense challenges",
    typicalColdStartMs: 450,
    costWeight: 6.0,
    capabilities: ["visual_qa", "webgl_canvas", "screenshot_diff", "pdf_render"],
  },
  6: {
    tier: 6,
    code: "LINUX_CONTAINER",
    name: "Tier 6: Sandboxed Linux Container",
    description: "Full Ubuntu OS userland for npm install, native compilers, Python binaries, and system toolchains",
    typicalColdStartMs: 500,
    costWeight: 10.0,
    capabilities: ["npm_install", "gcc_clang", "python_native", "container_sandbox"],
  },
};

/**
 * Dynamically evaluates the minimum required Execution Tier based on task requirements.
 */
export function evaluateTaskComputeTierRequirement(task: {
  code?: string;
  runtime?: string;
  needsContainer?: boolean;
  needsBrowser?: boolean;
  isHeavyVisualQa?: boolean;
  isLongRunningWorkflow?: boolean;
  hasNativeDependencies?: boolean;
  isPureFileSystemWork?: boolean;
}): ExecutionTier {
  if (task.needsContainer || task.hasNativeDependencies) {
    return 6;
  }
  if (task.isHeavyVisualQa) {
    return 5;
  }
  if (task.needsBrowser) {
    return 4;
  }
  if (task.isLongRunningWorkflow || task.runtime === "workflow") {
    return 3;
  }
  if (task.isPureFileSystemWork) {
    return 1;
  }
  return 2;
}

/**
 * Determines whether a failed execution should be promoted to a higher compute tier.
 */
export function shouldPromoteTier(
  currentTier: ExecutionTier,
  errorMessage: string
): { promote: boolean; nextTier?: ExecutionTier; reason?: string } {
  const err = errorMessage.toLowerCase();

  // Tier 2 (Isolate) failures involving missing native modules or OS binaries promote to Tier 6 (Container)
  if (currentTier === 2) {
    if (
      err.includes("cannot find module") ||
      err.includes("native addon") ||
      err.includes("spawn") ||
      err.includes("exec") ||
      err.includes("compiler") ||
      err.includes("npm")
    ) {
      return {
        promote: true,
        nextTier: 6,
        reason: "Detected missing OS binary or native dependency in isolate; promoting to Tier 6 Container Sandbox.",
      };
    }
  }

  // Tier 4 (Kitesurf) failures involving WebGL or Canvas promote to Tier 5 (Full Chromium)
  if (currentTier === 4) {
    if (
      err.includes("webgl") ||
      err.includes("canvas") ||
      err.includes("screenshot") ||
      err.includes("visual qa") ||
      err.includes("render")
    ) {
      return {
        promote: true,
        nextTier: 5,
        reason: "Detected visual rendering or WebGL requirement; promoting to Tier 5 Full Chromium.",
      };
    }
  }

  return { promote: false };
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
    // Tier 1 stored scripts are pure Virtual FS / R2 transforms.
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

  // Tier 3 or runtime:"workflow": dispatches to a durable CF Workflow instance
  if (tier === 3 || script.metadata.runtime === "workflow") {
    if (!env.workflowRunner) {
      return {
        ok: false,
        error: `Script '${script.metadata.name}' requires Tier 3 / runtime:"workflow" but no workflow runner is wired in this environment`,
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

  // Tiers 2, 4, 5, 6: delegate to the injected runner.
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
  return (
    {
      1: "T1 virtual-fs",
      2: "T2 v8-isolate",
      3: "T3 dynamic-workflow",
      4: "T4 kitesurf-browser",
      5: "T5 chromium-browser",
      6: "T6 container",
    } as const
  )[tier];
}
