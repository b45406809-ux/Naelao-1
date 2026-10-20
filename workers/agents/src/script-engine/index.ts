/**
 * Script-First Agent Engine — public surface.
 *
 * The authoritative agent model (original spec, bottom appendix "Script-First General
 * Agent Architecture", byte ~6672k). The agent's entire tool surface is six operations and
 * every capability is a script in a library. See docs/spec-appendix/A1 §A1.7.
 *
 * Usage from NaelaoAgentDO:
 *   const env = { scriptsBucket, vectorIndex, embedder, knowledgeWorker, ... };
 *   const cfg = await loadAgentConfig(scriptsBucket, spaceId, agentId);
 *   const tools = new ScriptToolSurface(env, cfg.scripts.prebuilt);
 *   const result = await runScriptLoop(env, tools, reasoner, cfg.scripts.prebuilt, {
 *     goal, startupObserve: cfg.scripts.startup_observe,
 *   });
 */

export * from "./types.js";
export * from "./fingerprint.js";
export { SkillLibrary, computeStabilityScore } from "./skill-library.js";
export { scriptFind, indexScriptEmbedding, removeScriptEmbedding, FIND_CONFIDENCE_FLOOR } from "./script-find.js";
export { classifyExecutionRoute, classifyExecutionRouteWithSentry, EXECUTION_ENGINES, requiresNativeCompilation, runStoredScript, tierLabel } from "./execution-ladder.js";
export { triageCustomerMessage, type CustomerMessageCategory, type CustomerMessageTriage } from "./customer-triage.js";
export { evaluateLoopAfterTool, type LoopEvaluation } from "./loop-evaluator.js";
export { beginConsultation, initialDeliberationState, type DeliberationState, type DeliberationStatus } from "./deliberation-state.js";
export { ScriptToolSurface, privacyBridgeCard, isPublicRoom, type RoomType } from "./tool-surface.js";
export * from "./step-pipeline.js";
export * from "./agent-firewall.js";
export * from "./prompt-assembly.js";
export { interceptPlatformCli, parseCliWords } from "./virtual-cli.js";
export { runObserve, observeFilesystem, observeApi } from "./observe.js";
export {
  runScriptLoop,
  parseRequiresApprovalFor,
  isGated,
  DEFAULT_ESCALATION,
  type Reasoner,
  type ReasonDecision,
  type EscalationConfig,
  type RunLoopOptions,
  type ApprovalMode,
  type ApprovedActionEvidence,
  stableStringify,
  approvalPolicyFingerprint,
} from "./loop.js";
export {
  loadAgentConfig,
  writeAgentConfig,
  createAgentConfigLockGateway,
  createRemoteAgentConfigLockGateway,
  listSpaceAgents,
  mergeMissingPrebuilt,
  type AgentConfig,
  type ScriptsConfig,
  type SkillsConfig,
} from "./agent-config.js";
export {
  DEFAULT_NAELAO_AGENT,
  LAUNCHPAD_ASSISTANT_PROFILE,
  LAUNCHPAD_ASSISTANT_DEFAULT_AUTO_APPROVED,
  launchpadAgentToProfile,
  launchpadProfiles,
  businessServicePrebuilts,
} from "./profiles.js";
export {
  PREBUILT_SCRIPTS,
  buildOperationMap,
  type PrebuiltScript,
  type PrebuiltOp,
  type PrebuiltOpContext,
} from "./prebuilt/index.js";
