/**
 * The Execution Ladder (spec §8) — routes script.run to the right tier automatically.
 * The agent never picks a tier; it calls script.run(name, params) and the orchestrator
 * routes by the script's declared `requires_tier`.
 *
 *   Tier 1 — Direct R2 (Workspace)      ~0ms boot. File ops only. Handled in-process.
 *   Tier 2 — V8 Isolate (Dynamic Worker) TS/JS + HTTP fetch. No fs, no native bins.
 *   Tier 3 — npm (Dynamic Worker + pkg)  Tier 2 + npm package resolution.
 *   Tier 4 — Browser (CF Browser)        DOM/click/fill/screenshot via naelao-browser proxy.
 *   Tier 5 — Container (SandboxDO)        Full Linux, Python/bash, native bins, multi-container.
 *
 * Tiers 2-5 execute arbitrary stored code and so are delegated to an injected
 * TieredCodeRunner (the concrete mechanism — Dynamic Worker Loader, browser proxy,
 * SandboxDO — lives in the host worker, not here). Tier 1 is implemented directly because
 * it is pure R2 and must always work even with no runner wired.
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
      1: "T1 direct-R2",
      2: "T2 v8-isolate",
      3: "T3 npm-isolate",
      4: "T4 browser",
      5: "T5 container",
    } as const
  )[tier];
}
