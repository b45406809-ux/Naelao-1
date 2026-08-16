/**
 * Prebuilt Script & Skill Catalogue (spec §12).
 *
 * These ship with Naelao as platform-level scripts, available to all agents. A prebuilt
 * script contributes a set of named OPERATIONS that the agent invokes via
 * script.run(opName, params). Operations are bundled platform code (not stored per-agent
 * in R2) — the agent's distilled scripts compose them.
 *
 * Catalogue: r2-workspace, web-search, file-manager, knowledge-base, notifications,
 *   sub-agent, dynamic-workflow, commerce, storefront, business-email, mcp-connector,
 *   browser-use (Tier 4), code-exec (Tier 2/5), memory (episodic/semantic Memory OS).
 * Deferred: vision-delegate (Workers AI vision model wiring — needs a multimodal model
 * binding decision, tracked separately from the Tier 2-5 execution substrate).
 */

import type { ScriptDomain, ExecutionTier, ScriptEngineEnv } from "../types.js";
import { r2Workspace } from "./r2-workspace.js";
import { fileManager } from "./file-manager.js";
import { webSearch } from "./web-search.js";
import { knowledgeBase } from "./knowledge-base.js";
import { artifacts } from "./artifacts.js";
import { notifications } from "./notifications.js";
import { subAgent } from "./sub-agent.js";
import { dynamicWorkflow } from "./dynamic-workflow.js";
import { commerce } from "./commerce.js";
import { storefront } from "./storefront.js";
import { businessEmail } from "./business-email.js";
import { mcpConnector } from "./mcp-connector.js";
import { browserUse } from "./browser-use.js";
import { codeExec } from "./code-exec.js";
import { memory } from "./memory.js";
import { fabric } from "./fabric.js";
import { wiki } from "./wiki.js";
import { projectJournal } from "./project-journal.js";
import { conversation } from "./conversation.js";
import { lock } from "./lock.js";
import { workspaceAdmin } from "./workspace-admin.js";
import { projectCoordination } from "./project-coordination.js";
import { businessDiagnostics } from "./business-diagnostics.js";
import { skillManager } from "./skill-manager.js";
import { localMachine } from "./local-machine.js";
import { workspace } from "./workspace.js";
import { wallet } from "./wallet.js";
import { businessWallet } from "./business-wallet.js";
import { revenueTracker } from "./revenue-tracker.js";

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
  /**
   * Optional one-line parameter hint per operation name — what `script.run(name, params)` actually
   * needs for THAT operation, surfaced to the reasoner via `availableOperationsGrouped()`.
   *
   * Live-reported bug this exists to close: `available_operations` told the model an operation's
   * NAME and its owning script's one-line description, but never its parameter shape — so a model
   * asked to "create a thread in project p1" called `thread.create({})` with no `project_id` at
   * all (the op silently falls back to the run's own ambient project, which is absent for a
   * Space Assistant run — so the thread landed with no project attached), and never even attempted
   * `thread.send_message` because it had no idea what fields that call needed. Optional so this can
   * be populated incrementally, script by script — an operation with no entry here works exactly
   * as it did before, just without the extra hint. See `project-coordination.ts` for the first
   * populated example.
   */
  paramHints?: Record<string, string>;
}

/** The full catalogue shipped in this build, keyed by prebuilt script name. */
export const PREBUILT_SCRIPTS: Record<string, PrebuiltScript> = {
  [r2Workspace.name]: r2Workspace,
  [fileManager.name]: fileManager,
  [webSearch.name]: webSearch,
  [knowledgeBase.name]: knowledgeBase,
  [artifacts.name]: artifacts,
  [notifications.name]: notifications,
  [subAgent.name]: subAgent,
  [dynamicWorkflow.name]: dynamicWorkflow,
  // Business primitives (spec §11): the only money-in path + Naelao-hosted storefront/email.
  [commerce.name]: commerce,
  [storefront.name]: storefront,
  [businessEmail.name]: businessEmail,
  // Connector layer: reach any external platform over MCP (Whop, Gumroad, Beehiiv, …).
  [mcpConnector.name]: mcpConnector,
  // Execution ladder Tiers 2/4/5: real browser + sandboxed code execution.
  [browserUse.name]: browserUse,
  [codeExec.name]: codeExec,
  // Memory OS: episodic log + semantic recall + user model (Hermes-pattern self-managed memory).
  [memory.name]: memory,
  // Memory OS Layer 4 (Fabric) + Layer 6 (LLM Wiki) — cross-session consolidation + curated vault.
  [fabric.name]: fabric,
  [wiki.name]: wiki,
  // The project's shared state file — what the goal is, what is done, what is left. Read on
  // demand (never injected per call) so an assistant can answer "where is this project at"
  // without walking every thread in it.
  [projectJournal.name]: projectJournal,
  // Search the full uncompacted transcript — the other half of conversation compaction, so a
  // model that is missing detail can look it up instead of answering from a partial record.
  [conversation.name]: conversation,
  // Generic named-lock primitive — the building block for script-composed concurrency
  // strategies (e.g. CSV row locking), not a bespoke locking mechanism per use case.
  [lock.name]: lock,
  // Workspace scaffolding (§A1.17 Phase G) — lets the Launchpad business-builder assistant
  // actually create/configure projects and read the agent roster, not just describe them.
  [workspaceAdmin.name]: workspaceAdmin,
  // Assistant<->project-agent consult lane + on-demand thread read (§A1.18 thread model) — a
  // private subthread, not a shared transcript with the visible user<->agent thread. See its
  // own header for why this is a separate script from workspace-admin (general, not Launchpad-
  // specific business scaffolding).
  [projectCoordination.name]: projectCoordination,
  [businessDiagnostics.name]: businessDiagnostics,
  // The agent's own skill library: what is working, what is broken and why, and what to do
  // about it (skill-health.ts derives the verdict; this is where the agent acts on it).
  [skillManager.name]: skillManager,
  // Local-machine-as-container (§A1.17 Phase M) — grant-checked read/write/exec on a builder's
  // own machine via the Naelao Local Agent tunnel. No default access; see local-machine.ts.
  [localMachine.name]: localMachine,
  // Explicit R2 <-> container copy/move/list (§A1.17 Phase R) — replaces the old implicit
  // full-sync-every-/exec-call behavior; see workspace.ts.
  [workspace.name]: workspace,
  // Launchpad Wallet (user-directed feature) — a business's own Naelao-held stored-value
  // balance; see wallet.ts's header for the money-transmission scope boundary this keeps to.
  [wallet.name]: wallet,
  // Business wallet (Whop autonomous sub-merchant model) — the business's OWN bank account:
  // real revenue in, real payouts out. A different concept from `wallet` above; see
  // business-wallet.ts's header for the distinction.
  [businessWallet.name]: businessWallet,
  // External revenue tracker (go-live monetization pass) — tracks a business's own reported
  // revenue on platforms Naelao never custodies money through (Whop), so a builder-configured
  // revenue-cut % can be billed as a surcharge; see revenue-tracker.ts's header.
  [revenueTracker.name]: revenueTracker,
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

export {
  r2Workspace,
  fileManager,
  webSearch,
  knowledgeBase,
  artifacts,
  notifications,
  subAgent,
  dynamicWorkflow,
  commerce,
  storefront,
  businessEmail,
  browserUse,
  codeExec,
  memory,
  fabric,
  wiki,
  projectJournal,
  conversation,
  lock,
  workspaceAdmin,
  projectCoordination,
  businessDiagnostics,
  localMachine,
};
