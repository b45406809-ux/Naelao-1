/**
 * Script-First Agent Engine — core types.
 *
 * Authoritative source: original spec, bottom appendix "Script-First General Agent
 * Architecture" (byte ~6672k). This appendix OVERRIDES the early ReAct/hardcoded-tools
 * framing of NaelaoAgentDO. See docs/spec-appendix/A1-script-agents-and-space-assistants.md
 * §A1.7 and CLAUDE.md CURRENT DIRECTION #8.
 *
 * The agent's entire tool surface is six operations:
 *   script.create / read / update / delete / find / run
 * Every capability (browser, filesystem, API, container, comms, MCP) is a SCRIPT in a
 * library, not a built-in tool. The loop is:
 *   OBSERVE → FINGERPRINT → FIND → GATE → EXECUTE → VERIFY → DISTILL
 */

/** Execution tier a script declares (the orchestrator routes script.run by this). */
export type ExecutionTier = 1 | 2 | 3 | 4 | 5;

/** Domains an observe/action script can target. Open-ended by design. */
export type ScriptDomain =
  | "browser"
  | "filesystem"
  | "api"
  | "container"
  | "comms"
  | "compute"
  | "knowledge"
  | "orchestration"
  | string;

/** A single parameter the script accepts. */
export interface ScriptParameter {
  name: string;
  type: string;
  description: string;
  required: boolean;
  default?: unknown;
}

/** Why and how a version came to be (one entry per version in patch_history). */
export interface PatchRecord {
  version: number;
  created_at: number;
  patch_type: "initial" | "minor_fix" | "re_derivation" | "split" | "failed_patch";
  reason: string;
  fingerprint_before?: string;
  fingerprint_after?: string;
  success_count_at_patch: number;
  failure_count_at_patch: number;
}

/**
 * Full metadata stored alongside a script's code (spec §4.1).
 * Persisted as SCRIPT.md (human + JSON front-matter) in R2; the JSON form is the source
 * of truth the engine reads.
 */
export interface ScriptMetadata {
  // Identity
  name: string;
  version: number;
  domain: ScriptDomain;

  // Retrieval
  description: string;
  /** Embedding of description + code summary (for script.find ANN search). */
  embedding_vector?: number[];
  tags: string[];

  // Preconditions
  /** JSON-schema-like shape the OBSERVE snapshot must satisfy for this script to apply. */
  fingerprint_schema: Record<string, unknown>;
  preconditions: string[];

  // Parameters
  parameters: ScriptParameter[];

  // Dependencies (skill graph)
  calls: string[];
  requires_tier: ExecutionTier;

  // Required credentials (resolved via credentials worker before L1 execution; A1.1)
  required_credentials?: string[];

  // Health
  success_count: number;
  failure_count: number;
  patch_history: PatchRecord[];
  /** Derived signal in [0,1]; gates L1 candidacy and sorts script.find results. */
  stability_score: number;

  // Provenance
  /** "prebuilt" = bundled platform script; "distilled" = authored by an agent at L4;
   *  "authored" = installed by a builder/space. */
  origin: "prebuilt" | "distilled" | "authored";
  created_at: number;
  updated_at: number;
}

/** A script as stored: metadata + code. Prebuilt scripts carry a handler instead of code. */
export interface StoredScript {
  metadata: ScriptMetadata;
  /** TypeScript/JS source for tiered execution (agent-distilled / authored scripts). */
  code?: string;
}

/** Environment observation snapshot (spec §9). The `fingerprint` is the gating hash. */
export interface ObserveSnapshot {
  type: ScriptDomain;
  timestamp: number;
  /** Deterministic hash of the state properties that matter for script validity. */
  fingerprint: string;
  /** Arbitrary domain-specific fields (dom_hash, file_mtimes, schema_hash, …). */
  [field: string]: unknown;
}

/** Result of running a script at any tier. */
export interface ScriptRunResult {
  ok: boolean;
  /** Script return value (JSON-serializable). */
  output?: unknown;
  error?: string;
  tier: ExecutionTier;
  /** Milliseconds of wall-clock execution. */
  duration_ms: number;
  /** Reasoning-model tokens consumed by this run (0 for pure script execution). */
  tokens_used: number;
}

/** A candidate returned by script.find. */
export interface FindCandidate {
  name: string;
  metadata: ScriptMetadata;
  semantic_similarity: number;
  /** stability_score × semantic_similarity (the sort key). */
  confidence: number;
}

/** Escalation level chosen by GATE (spec §5). */
export type EscalationLevel = "L1" | "L2" | "L3" | "L4";

/** Outcome of one OBSERVE→…→DISTILL pass. */
export interface LoopResult {
  level: EscalationLevel;
  script_name?: string;
  result?: ScriptRunResult;
  /** Set when a new/patched script was produced and queued for async compile. */
  distilled_script?: string;
  notes: string[];
}

// ── Engine bindings (dependency-injected so the engine is testable + DO-agnostic) ──────

/** Embeds text into a vector for script.find. Backed by Workers AI or an external model. */
export interface Embedder {
  embed(text: string): Promise<number[]>;
}

/** Minimal Vectorize surface the engine needs (avoids a hard dep on the CF type). */
export interface VectorIndex {
  upsert(vectors: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }>): Promise<unknown>;
  query(
    vector: number[],
    opts: { topK: number; filter?: Record<string, unknown>; returnMetadata?: boolean }
  ): Promise<{ matches: Array<{ id: string; score: number; metadata?: Record<string, unknown> }> }>;
  deleteByIds(ids: string[]): Promise<unknown>;
}

/**
 * Runs arbitrary stored script code at a given tier. Injected because the concrete
 * mechanism differs by environment: Dynamic Worker Loader (T2/T3), CF Browser proxy (T4),
 * SandboxDO/Containers (T5). T1 is handled in-process by the R2 store.
 */
export interface TieredCodeRunner {
  run(params: {
    name: string;
    code: string;
    tier: ExecutionTier;
    args: Record<string, unknown>;
    spaceId: string;
    agentId: string;
  }): Promise<ScriptRunResult>;
}

/**
 * Orchestration hooks the host (NaelaoAgentDO) provides for prebuilt scripts that need
 * platform primitives the engine itself does not own (sub-agents, workflows). Optional —
 * when absent the corresponding prebuilt operations report themselves unavailable.
 */
export interface OrchestrationHooks {
  spawnSubAgent?(config: Record<string, unknown>): Promise<{ id: string }>;
  sendToSubAgent?(id: string, task: unknown): Promise<unknown>;
  receiveFromSubAgent?(id: string): Promise<unknown>;
  terminateSubAgent?(id: string): Promise<void>;
  workflowCreate?(name: string, code: string): Promise<{ id: string }>;
  workflowRun?(name: string, params: Record<string, unknown>): Promise<unknown>;
  workflowSchedule?(name: string, cron: string): Promise<{ id: string }>;
  workflowStatus?(id: string): Promise<unknown>;
}

/**
 * HITL (Human-in-the-Loop) gateway interface (spec §10 / CLAUDE.md task #10).
 * Injected by NaelaoAgentDO when HITL_APPROVAL_DO is bound; absent in unit tests.
 */
export interface HITLGateway {
  /**
   * Pause execution and wait for a human to approve or reject the named action.
   * Polls HITLApprovalDO (or the host equivalent) until resolved or timed out (28s).
   * Returns { approved: true } to proceed, { approved: false } to abort.
   */
  requestApproval(params: {
    runId: string;
    sessionId: string;
    actionName: string;
    actionInput: Record<string, unknown>;
    description: string;
  }): Promise<{ approvalId: string; approved: boolean; reason?: string }>;
}

/** Everything the engine needs from the host (NaelaoAgentDO) to operate. */
export interface ScriptEngineEnv {
  /** R2 bucket holding the skill library (spaces/{spaceId}/scripts/...). */
  scriptsBucket: R2Bucket;
  /** R2 bucket for the agent's persistent workspace (spaces/{spaceId}/workspace/...).
   *  Defaults to scriptsBucket when not separately provisioned. */
  workspaceBucket?: R2Bucket;
  /** Vectorize index for script.find (optional — engine degrades to tag/text search). */
  vectorIndex?: VectorIndex;
  embedder?: Embedder;
  /** Runner for stored-code tiers (T2-T5). Optional — T1 always works without it. */
  codeRunner?: TieredCodeRunner;
  /** Service bindings used by prebuilt scripts. */
  knowledgeWorker?: Fetcher;
  spacesWorker?: Fetcher;
  notificationsWorker?: Fetcher;
  /** Billing worker — holds Lemon Squeezy creds + Naelao store; the only money-in path. */
  billingWorker?: Fetcher;
  /** Host-provided primitives for sub-agent / workflow prebuilt scripts. */
  orchestration?: OrchestrationHooks;
  /** HITL approval gateway — present when HITLApprovalDO is wired up. */
  hitlGateway?: HITLGateway;
  /** Identity for scoping R2 keys + Vectorize filters. */
  spaceId: string;
  agentId: string;
  tenantId: string;
}
