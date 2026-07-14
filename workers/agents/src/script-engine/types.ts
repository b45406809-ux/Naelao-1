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
  /**
   * §A1.17 Phase J: "isolate" (default) executes synchronously in the Tier 2-5 runner and
   * blocks the calling script.run for the result. "workflow" dispatches to a durable CF
   * Workflow instance instead (step retries, survives restarts, can run for hours/days) and
   * returns immediately with a workflow id to poll — for long-running/cron automations that
   * must not hold an isolate or a DO awake the whole time. Orthogonal to requires_tier (which
   * still governs what the eventual execution is allowed to do).
   */
  runtime?: "isolate" | "workflow";
  /**
   * §A1.17 Phase L: when set on a `requires_tier: 5` script, execution routes to the named
   * Container Marketplace image's own DO/binding instead of the base per-project ToolSandboxDO
   * (Phase K) — a dedicated, long-running container (a database, a cache) rather than the shared
   * ephemeral sandbox. Fails closed with a clear error if the image isn't wired to a live binding
   * yet (see `container-catalogue.ts`'s `available` flag — every image ships unavailable this
   * pass; this field's routing hook is real ahead of any image actually going live).
   */
  container_image?: string;

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
  /** Growth-layer "click Install" onboarding (mcp-connector.ts's resolveServerId): set when the
   *  op failed because a KNOWN catalogue connector isn't connected for this space yet — lets the
   *  reasoning loop's answer name the exact app to install instead of a bare "not found" error,
   *  and gives a future UI a structured signal to render a Connect action from (not just prose). */
  needs_connector?: boolean;
  connector_id?: string;
  connector_name?: string;
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
/**
 * One structured step of a run's execution — the persisted counterpart to `notes: string[]`
 * (which stays as a human-readable log line, unchanged). Phase HX1: this is what makes a run's
 * timing/tokens/tier/outcome queryable per-step (a builder trace view, and the input SkillOpt-
 * style skill evolution mines for consensus failure attributes), instead of only living in the
 * ephemeral response body.
 */
export interface TraceStep {
  seq: number;
  /** "observe" | "find" | "gate" | "reason" | "run" */
  phase: string;
  /** Script name, when the step concerns one (find top candidate, reason decision, run). */
  name?: string | undefined;
  tier?: number | undefined;
  duration_ms?: number | undefined;
  tokens?: number | undefined;
  ok?: boolean | undefined;
  detail?: string | undefined;
  /** Date.now() at the moment the step was recorded. */
  ts: number;
}

export interface LoopResult {
  level: EscalationLevel;
  script_name?: string;
  result?: ScriptRunResult;
  /** Set when a new/patched script was produced and queued for async compile. */
  distilled_script?: string;
  notes: string[];
  /** Structured per-phase/per-script.run trace (Phase HX1) — same run, richer than `notes`. */
  trace: TraceStep[];
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
    /** §A1.17 Phase I: needed so Tier 2-4 isolates can mint a scoped internal token for the
     *  ctx.mcp loopback (mcp-hub is HMAC-gated) without ever exposing the platform secret itself
     *  to the isolate. */
    tenantId: string;
    /** §A1.17 Phase K: which R2 workspace (see workspacePrefix()) a Tier 5 container syncs
     *  files with — project-scoped when set, space-scoped (the Space Assistant) when absent.
     *  Only consumed by Tier 5 today; Tiers 2-4 don't touch a filesystem. */
    projectId?: string;
    /** §A1.17 Phase L: routes a Tier 5 run to this Container Marketplace image's own binding
     *  instead of the base per-project ToolSandboxDO. Absent = the ordinary Phase K sandbox. */
    containerImage?: string;
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
 * §A1.17 Phase J — dispatches a stored script tagged `metadata.runtime === "workflow"` to a
 * durable CF Workflow instance instead of running it synchronously in an isolate. The runner
 * re-resolves the script BY NAME inside the workflow step (the same path a trigger fire or
 * scheduled job already uses — see `fireScriptDirectly`/`agent-do/triggers/fire`), so it never
 * needs to carry code through workflow instance params and a script edited between schedule and
 * fire is picked up automatically, matching the skill library's own versioning semantics.
 */
export interface WorkflowRunner {
  start(params: {
    name: string;
    args: Record<string, unknown>;
    spaceId: string;
    agentId: string;
    tenantId: string;
    projectId?: string;
  }): Promise<{ id: string }>;
  status(id: string): Promise<{ status: string; output?: unknown; error?: string }>;
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
 * Generic named-lock primitive, exposed to scripts via the `lock` prebuilt. Deliberately
 * minimal (acquire/release/status) — Naelao does not ship a bespoke locking mechanism per
 * use case (e.g. "CSV row locking"); an assistant/agent composes its OWN concurrency
 * strategy out of this primitive (a script that acquires a lock keyed by row number before
 * writing, checks/aborts if not granted, releases after). Backed by ConcurrencyDO,
 * generalized beyond its original sub-agent-tree-gating use.
 */
export interface LockGateway {
  acquire(params: { key: string; holderId: string; limit?: number; ttlMs?: number }): Promise<{ granted: boolean; active: number; limit?: number; degraded?: boolean }>;
  release(params: { key: string; holderId: string }): Promise<void>;
  status(key: string): Promise<{ active: number }>;
}

/**
 * §A1.25: lets a prebuilt op make its OWN direct LLM call rather than going through the
 * reasoner's decide() loop — needed for web-search's `grounded_answer` op, which wants
 * Anthropic's native web-search tool (proxied by CF AI Gateway, billed through the same Unified
 * Billing as every other LLM call — no separate provider key). Returns real token usage so the
 * caller (ScriptToolSurface.run's success branch) can fold it into ScriptRunResult and have it
 * billed exactly like reasoner-driven tokens are, instead of being a free, unmetered LLM call.
 */
export interface LlmCallerGateway {
  callWithNativeWebSearch(args: { model: string; query: string; maxUses?: number | undefined }): Promise<{
    answer: string;
    citations: Array<{ title?: string | undefined; url?: string | undefined }>;
    tokens_used: number;
    input_tokens: number;
    output_tokens: number;
  }>;
}

/**
 * Local-machine-as-container (spec "Local PC as a Container Target", gap G-3; §A1.17 Phase M).
 * Relays a grant-checked op (read_file/write_file/exec) to a builder's own machine over the
 * WebSocket tunnel LocalTunnelDO holds. `userId` addresses WHICH (space, user) tunnel to use —
 * the local-machine prebuilt resolves it from the matching grant's own user_id, never from a
 * caller-supplied field. Grant checking happens entirely in the prebuilt, before this gateway is
 * ever called; this interface has no opinion on what an op's params mean.
 */
export interface LocalTunnelGateway {
  exec(params: { userId: string; op: string; params: Record<string, unknown> }): Promise<{ ok: boolean; result?: unknown; error?: string }>;
  status(userId: string): Promise<{ connected: boolean }>;
}

/**
 * §A1.17 Phase R: the container side of the explicit multi-workspace model — R2 (always
 * available, small/text files, durable across restarts) and the Tier-5 container's own local
 * disk (large/binary/stateful-capable, but only persists while that specific container instance
 * stays warm) are DIFFERENT filesystems an agent explicitly moves files between via the
 * `workspace` prebuilt's copy/move/list ops, rather than one being silently kept in sync with
 * the other on every call. This gateway is only the container half; the R2 half of a copy is an
 * ordinary R2 read/write in that same prebuilt (same bucket/prefix Tier 1's r2-workspace uses) —
 * there is no DO-side R2 logic left in ToolSandboxDO at all. Addressed the SAME way
 * code-runner.ts's runContainer addresses the DO for /exec (sandbox:{space}:{project|_assistant}),
 * so copy/list/exec all operate on the one container instance a project's threads share.
 */
export interface ContainerWorkspaceGateway {
  list(): Promise<{ files: string[] }>;
  read(paths?: string[]): Promise<{ files: Record<string, string> }>;
  write(files: Record<string, string>): Promise<{ ok: boolean }>;
  remove(paths: string[]): Promise<{ ok: boolean }>;
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
  /** Dispatches `runtime:"workflow"` scripts to a durable CF Workflow. Optional — such scripts
   *  fail closed with an honest "unavailable" when absent, same precedent as codeRunner. */
  workflowRunner?: WorkflowRunner;
  /** Service bindings used by prebuilt scripts. */
  knowledgeWorker?: Fetcher;
  spacesWorker?: Fetcher;
  notificationsWorker?: Fetcher;
  /** Billing worker — holds Lemon Squeezy creds + Naelao store; the only money-in path. */
  billingWorker?: Fetcher;
  /** MCP hub worker — registry + tool proxy for external-platform connectors (mcp-connector). */
  mcpHubWorker?: Fetcher;
  /** Credentials worker — the wallet prebuilt's check_bypass op reads a business's own
   *  credential list to detect a connected third-party payment provider. */
  credentialsWorker?: Fetcher;
  /** Host-provided primitives for sub-agent / workflow prebuilt scripts. */
  orchestration?: OrchestrationHooks;
  /** HITL approval gateway — present when HITLApprovalDO is wired up. */
  hitlGateway?: HITLGateway;
  /** Generic named-lock primitive — present when CONCURRENCY_DO is wired up (the `lock`
   *  prebuilt reports itself degraded, not unavailable, when absent — see LockGateway). */
  lockGateway?: LockGateway;
  /** Local-machine-as-container (§A1.17 Phase M) — present when LOCAL_TUNNEL is wired up. The
   *  `local-machine` prebuilt reports itself unavailable, not degraded, when absent (unlike
   *  lockGateway, there's no safe fallback behavior for "pretend the local machine exists"). */
  localTunnel?: LocalTunnelGateway;
  /** §A1.17 Phase R — the container half of the explicit multi-workspace model. Present when
   *  TOOL_SANDBOX is wired up; the `workspace` prebuilt reports itself unavailable, not
   *  degraded, when absent (same posture as localTunnel — no safe fallback for "pretend the
   *  container exists"). */
  containerWorkspace?: ContainerWorkspaceGateway;
  /** Memory OS (structured facts + episodic + semantic recall) — present when the host DO
   *  has initialized its memory tables. Absent in environments that haven't wired it yet. */
  memoryStore?: MemoryStore;
  /** §A1.25 — present when the host DO can make its own direct LLM calls (native web search).
   *  Absent → web-search's grounded_answer op reports itself unavailable, same posture as every
   *  other optional gateway here. */
  llmCaller?: LlmCallerGateway;
  /** Identity for scoping R2 keys + Vectorize filters. */
  spaceId: string;
  agentId: string;
  tenantId: string;
  /** For minting the internal HMAC token any direct (non-router) service-binding call to
   *  another worker (spacesWorker, knowledgeWorker, ...) needs — see mintInternalToken,
   *  @naelao/http. Optional so environments that never make such a call (most script tests)
   *  don't need to supply it. */
  platformSecret?: string;
  /** The end-user this run is on behalf of (set per /script/run call). Scopes the user model
   *  (Memory OS) and per-(channel,user) sessions. Absent for space-level/system-triggered runs. */
  userId?: string;
  /**
   * The project this run is bound to, when it's an ordinary (project-scoped) Naelao Agent
   * thread rather than the Space Assistant. Determines the R2 workspace prefix (see
   * `workspacePrefix()` below) — every thread's agent in the SAME project shares one
   * filesystem (e.g. a project-wide ledger.csv), while the Space Assistant's workspace stays
   * space-wide. Absent = space-scoped (the Space Assistant, or a legacy unscoped run).
   */
  projectId?: string;
  /**
   * Execution ladder ceiling (1-5) for this run — set on customer-facing bot projects
   * (SpaceDO `projects.execution_ceiling`) so a restricted bot can never use a tier above
   * what the admin configured (e.g. ceiling=2 means "talk and look things up, never touch a
   * container or browser"). Absent = unrestricted (the normal builder-workspace default).
   * Enforced structurally in ScriptToolSurface — not a prompt instruction.
   */
  maxTier?: ExecutionTier;
  /**
   * F-36 — the assistant's clamped effective role when this run acts ON BEHALF OF a specific
   * user in a project (resolved from SpaceDO's `/projects/:id/assistant-access`, the min of
   * that user's own project_members role and the row's assistant_mode). `"viewer"` makes the
   * run read-only: ScriptToolSurface structurally refuses script.create/update/delete,
   * stored-script execution, and any prebuilt op not on the read-safe allowlist (see
   * assistant-access.ts). Absent = unclamped — a system/autonomous run with no acting user,
   * or an acting user whose effective role is editor/owner. A `null` effective role
   * (assistant_mode='none', or a plain non-member) never reaches this env: the run is refused
   * before the engine is invoked. Enforced structurally (the maxTier precedent), not a prompt
   * instruction.
   */
  effectiveRole?: "owner" | "editor" | "viewer";
}

/**
 * The single place that decides whether a run's R2 workspace is space-scoped or
 * project-scoped — every workspace-touching prebuilt (r2-workspace, file-manager,
 * observe_filesystem) and any future one must call this rather than re-deriving the prefix,
 * so the space/project boundary is enforced in exactly one place.
 *
 * Space-scoped (`env.projectId` absent) = the Space Assistant, or a legacy unscoped run.
 * Project-scoped (`env.projectId` set) = an ordinary Naelao Agent thread — every thread's
 * agent within the SAME project reads/writes the SAME filesystem (spec: a project is
 * workspace-scoped; threads within it share one R2 workspace).
 */
export function workspacePrefix(env: Pick<ScriptEngineEnv, "spaceId" | "projectId">): string {
  return env.projectId
    ? `spaces/${env.spaceId}/projects/${env.projectId}/workspace/`
    : `spaces/${env.spaceId}/workspace/`;
}
