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
