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
  /** Directional breakdown of tokens_used, when the reasoner reported it — lets the host
   *  compute a real per-model USD/credit cost (input and output are priced differently).
   *  Absent for pure script execution, where tokens_used is already 0. */
  input_tokens?: number;
  output_tokens?: number;
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

// ── Memory OS (spec "Space Assistants — OpenClaw + CF Thinker + Memory OS", byte ~141822) ──
// Layer 3 (Structured Facts) + Layer 5 (Vector DB) of the 6-layer pipeline, implemented as
// NaelaoAgentDO SQLite + Vectorize and injected here the same way codeRunner/hitlGateway are.
// Layers 1 (Workspace/R2) and 2 (Sessions/FTS5) already exist (r2-workspace, messages_fts).

/** A single recalled memory, regardless of which layer it came from. */
export interface MemoryRecallResult {
  id: string;
  layer: "structured_fact" | "episodic" | "semantic";
  text: string;
  /** entity/relation/attribute when layer === "structured_fact". */
  entity?: string;
  relation?: string;
  attribute?: string;
  score: number;
  user_id?: string;
}

/** A Layer 4 (Fabric) entry — a cross-session consolidated summary (spec: Icarus framework). */
export interface FabricEntry {
  id: string;
  sessionId: string;
  summary: string;
  keyInsights: string[];
  /** Relevance to a recallFabric() query in [0,1]; 0 for briefFabric() (no query, just recency). */
  score: number;
  createdAt: number;
}

/** A Layer 6 (LLM Wiki) article — an auto-curated concept/entity definition. */
export interface WikiArticle {
  concept: string;
  definition: string;
  relationships: string[];
  updatedAt: number;
}

export interface MemoryStore {
  /**
   * Layer 3: remember a durable fact (entity/relation/attribute triple) OR Layer 5-bound
   * episodic note when entity/relation/attribute are omitted (free-text, scored by
   * `importance` for later promotion to semantic memory).
   */
  remember(entry: {
    userId?: string;
    text: string;
    entity?: string;
    relation?: string;
    attribute?: string;
    /** 0-1; gates promotion to the Vectorize semantic layer. Default 0.5. */
    importance?: number;
  }): Promise<{ id: string }>;
  /** Surgical recall (spec "Pre-Flight Check"): structured facts + episodic + semantic, merged. */
  recall(query: { userId?: string; text: string; limit?: number }): Promise<MemoryRecallResult[]>;
  forget(id: string): Promise<void>;

  /**
   * Layer 4 (Fabric) — cross-session context consolidator. Records a post-run summary + key
   * insights (spec: "Runs LLM-driven session extraction post-run"); the host calls this once
   * per completed run, not per message — see NaelaoAgentDO's handleScriptRun.
   */
  recordFabric(entry: { userId?: string; sessionId: string; summary: string; keyInsights?: string[] }): Promise<{ id: string }>;
  /** spec's `fabric_recall` tool — matched + score-filtered (>0.70 floor) against past summaries. */
  recallFabric(query: { userId?: string; text: string; limit?: number }): Promise<FabricEntry[]>;
  /** spec's `fabric_brief` tool — the N most recent cross-session summaries, no query needed. */
  briefFabric(userId: string | undefined, limit?: number): Promise<FabricEntry[]>;

  /**
   * Layer 6 (LLM Wiki) — auto-curated concept/entity vault (spec: `wiki-continuous-ingest`).
   * Upsert is keyed on (userId, concept): re-stating a concept refreshes its definition rather
   * than duplicating it, the same merge behavior as Layer 3 structured facts.
   */
  upsertWikiConcept(entry: { userId?: string; concept: string; definition: string; relationships?: string[] }): Promise<{ concept: string }>;
  lookupWikiConcept(userId: string | undefined, concept: string): Promise<WikiArticle | null>;
  searchWiki(query: { userId?: string; text: string; limit?: number }): Promise<WikiArticle[]>;
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
  /** MCP hub worker — registry + tool proxy for external-platform connectors (mcp-connector). */
  mcpHubWorker?: Fetcher;
  /** Host-provided primitives for sub-agent / workflow prebuilt scripts. */
  orchestration?: OrchestrationHooks;
  /** HITL approval gateway — present when HITLApprovalDO is wired up. */
  hitlGateway?: HITLGateway;
  /** Memory OS (structured facts + episodic + semantic recall) — present when the host DO
   *  has initialized its memory tables. Absent in environments that haven't wired it yet. */
  memoryStore?: MemoryStore;
  /** Identity for scoping R2 keys + Vectorize filters. */
  spaceId: string;
  agentId: string;
  tenantId: string;
  /** The end-user this run is on behalf of (set per /script/run call). Scopes the user model
   *  (Memory OS) and per-(channel,user) sessions. Absent for space-level/system-triggered runs. */
  userId?: string;
  /**
   * Execution ladder ceiling (1-5) for this run — set on customer-facing bot projects
   * (SpaceDO `projects.execution_ceiling`) so a restricted bot can never use a tier above
   * what the admin configured (e.g. ceiling=2 means "talk and look things up, never touch a
   * container or browser"). Absent = unrestricted (the normal builder-workspace default).
   * Enforced structurally in ScriptToolSurface — not a prompt instruction.
   */
  maxTier?: ExecutionTier;
}
