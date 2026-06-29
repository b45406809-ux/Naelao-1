/**
 * Prebuilt Script & Skill Catalogue (spec §12).
 *
 * These ship with Naelao as platform-level scripts, available to all agents. A prebuilt
 * script contributes a set of named OPERATIONS that the agent invokes via
 * script.run(opName, params). Operations are bundled platform code (not stored per-agent
 * in R2) — the agent's distilled scripts compose them.
 *
 * This build ships the Launchpad subset:
 *   r2-workspace, web-search, file-manager, knowledge-base, notifications,
 *   sub-agent, dynamic-workflow
 * Deferred per CLAUDE.md CURRENT DIRECTION #8: browser-use, vision-delegate, code-exec,
 * sandbox-container, mcp-connector.
 */

import type { ScriptDomain, ExecutionTier, ScriptEngineEnv } from "../types.js";
import { r2Workspace } from "./r2-workspace.js";
import { fileManager } from "./file-manager.js";
import { webSearch } from "./web-search.js";
import { knowledgeBase } from "./knowledge-base.js";
import { notifications } from "./notifications.js";
import { subAgent } from "./sub-agent.js";
import { dynamicWorkflow } from "./dynamic-workflow.js";

/** Context handed to every prebuilt operation. */
export interface PrebuiltOpContext {
  env: ScriptEngineEnv;
  /** Call another script (prebuilt op or stored) — enables skills calling skills (§7). */
  run: (name: string, params: Record<string, unknown>) => Promise<unknown>;
}

export type PrebuiltOp = (
  args: Record<string, unknown>,
  ctx: PrebuiltOpContext
) => Promise<unknown>;

export interface PrebuiltScript {
  name: string;
  description: string;
  domain: ScriptDomain;
  requires_tier: ExecutionTier;
  /** Operation name → handler. Operation names are what the agent passes to script.run. */
  operations: Record<string, PrebuiltOp>;
}

/** The full catalogue shipped in this build, keyed by prebuilt script name. */
export const PREBUILT_SCRIPTS: Record<string, PrebuiltScript> = {
  [r2Workspace.name]: r2Workspace,
  [fileManager.name]: fileManager,
  [webSearch.name]: webSearch,
  [knowledgeBase.name]: knowledgeBase,
  [notifications.name]: notifications,
  [subAgent.name]: subAgent,
  [dynamicWorkflow.name]: dynamicWorkflow,
};

/**
 * Build a flat operation map (opName → {handler, prebuilt}) for an agent's enabled
 * prebuilt list (scripts.json `prebuilt`). Unknown prebuilt names are ignored.
 */
export function buildOperationMap(
  enabled: string[]
): Map<string, { op: PrebuiltOp; prebuilt: PrebuiltScript }> {
  const map = new Map<string, { op: PrebuiltOp; prebuilt: PrebuiltScript }>();
  for (const name of enabled) {
    const prebuilt = PREBUILT_SCRIPTS[name];
    if (!prebuilt) continue;
    for (const [opName, op] of Object.entries(prebuilt.operations)) {
      map.set(opName, { op, prebuilt });
    }
  }
  return map;
}

export { r2Workspace, fileManager, webSearch, knowledgeBase, notifications, subAgent, dynamicWorkflow };
