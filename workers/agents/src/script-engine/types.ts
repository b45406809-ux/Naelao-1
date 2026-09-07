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
export type ExecutionTier = 1 | 2 | 3 | 4 | 5 | 6;

export interface AvosFsRuntime {
  read: (path: string, opts?: { offset?: number; limit?: number }) => Promise<{ content: string; totalLines: number }>;
  write: (path: string, content: string) => Promise<{ ok: boolean; bytesWritten?: number }>;
  edit: (path: string, oldStr: string, newStr: string) => Promise<{ ok: boolean; message?: string }>;
  grep: (pattern: string, path?: string) => Promise<{ matches: Array<{ file: string; line: number; text: string }> }>;
  glob: (pattern: string) => Promise<{ files: string[] }>;
}

export interface AvosProjectRuntime {
  id: string;
  getJournal: () => Promise<{ tasks: Array<{ id: string; title: string; status: string }> } | any>;
  updateTaskStatus?: (taskId: string, status: "PENDING" | "IN_PROGRESS" | "COMPLETED") => Promise<{ ok: boolean }>;
  updateJournal?: (status: string) => Promise<{ ok: boolean }>;
  createTask?: (title: string) => Promise<{ ok: boolean }>;
  listThreads?: () => Promise<Array<{ id: string; title: string }>>;
  postMessage?: (threadId: string, text: string) => Promise<{ ok: boolean }>;
}

export interface AvosSpaceRuntime {
  id: string;
  getWalletBalance: () => Promise<{ balance_cents: number; currency?: string }>;
  createProject?: (name: string, kind: string, templateId?: string) => Promise<{ id: string; name: string }>;
  listProjects?: () => Promise<Array<{ id: string; name: string; kind: string }>>;
  sendNotification?: (title: string, body: string) => Promise<{ ok: boolean }>;
}

export interface AvosVaultRuntime {
  fetchWithAuth: (url: string, opts: { credentialName: string; method?: string; body?: any; headers?: Record<string, string> }) => Promise<Response>;
}

export interface AvosCliRuntime {
  exec: (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  register: (name: string, def: { description: string; subcommands: Record<string, string>; handlerCode: string }) => Promise<{ ok: boolean }>;
  extend: (name: string, subcommand: string, handlerSnippet: string) => Promise<{ ok: boolean }>;
  formatTable: (data: Array<Record<string, any>>) => string;
}

export interface AvosConnectorsRuntime {
  use: (logicalAlias: string) => Promise<any>;
  isConnected: (platform: string) => Promise<boolean>;
  requestConnectionDialog: (platforms: string[], opts: { reason: string }) => never;
}

export interface AvosMcpRuntime {
  call: (server: string, tool: string, params: Record<string, any>) => Promise<any>;
  listTools: (server: string) => Promise<Array<{ name: string; description: string }>>;
}

export interface AvosBrowserRuntime {
  scrape?: (url: string, selector?: string) => Promise<{ content: string; title: string }>;
  navigate?: (url: string) => Promise<{ title: string; textContent: string }>;
  click?: (selector: string) => Promise<{ ok: boolean }>;
  type?: (selector: string, text: string) => Promise<{ ok: boolean }>;
  extract?: (selector: string) => Promise<string[]>;
}

export interface AvosRuntimeContext {
  // 1. Filesystem (Backed by ArtifactFS / DO SQLite)
  fs: {
    read: (path: string, opts?: { offset?: number; limit?: number }) => Promise<{ content: string; totalLines: number }>;
    write: (path: string, content: string) => Promise<{ ok: boolean }>;
    edit: (path: string, oldStr: string, newStr: string) => Promise<{ ok: boolean }>;
    grep: (pattern: string, path?: string) => Promise<{ matches: Array<{ file: string; line: number; text: string }> }>;
    glob: (pattern: string) => Promise<{ files: string[] }>;
  };

  // 2. Zero-Leak Vault (Outbound Worker Edge Egress)
  vault: {
    fetchWithAuth: (url: string, opts: { credentialName: string; method?: string; body?: any; headers?: Record<string, string> }) => Promise<Response>;
  };

  // 3. Virtual CLI Bus
  cli?: {
    exec: (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
    register: (name: string, def: { description: string; subcommands: Record<string, string>; handlerCode: string }) => Promise<{ ok: boolean }>;
    extend: (name: string, subcommand: string, handlerSnippet: string) => Promise<{ ok: boolean }>;
    formatTable: (data: Array<Record<string, any>>) => string;
  };

  // 4. Decoupled Connectors (Composio/OAuth Wrappers)
  connectors?: {
    use: (logicalAlias: string) => Promise<any>;
    isConnected: (platform: string) => Promise<boolean>;
    requestConnectionDialog: (platforms: string[], opts: { reason: string }) => never; // Emits MCP-UI and throws
  };

  // 5. Browser & Vision Senses
  browser?: {
    scrape: (url: string, selector?: string) => Promise<{ content: string; title: string }>;
    navigate?: (url: string) => Promise<{ title: string; textContent: string }>;
    click?: (selector: string) => Promise<{ ok: boolean }>;
    type?: (selector: string, text: string) => Promise<{ ok: boolean }>;
    extract?: (selector: string) => Promise<string[]>;
  };

  // 6. Project & Space Coordination
  project?: {
    id: string;
    getJournal: () => Promise<{ tasks: Array<{ id: string; title: string; status: string }> } | any>;
    updateTaskStatus?: (taskId: string, status: "PENDING" | "IN_PROGRESS" | "COMPLETED") => Promise<{ ok: boolean }>;
    updateJournal?: (status: string) => Promise<{ ok: boolean }>;
    createTask?: (title: string) => Promise<{ ok: boolean }>;
    listThreads?: () => Promise<Array<{ id: string; title: string }>>;
    postMessage?: (threadId: string, text: string) => Promise<{ ok: boolean }>;
  };

  space?: {
    id: string;
    getWalletBalance: () => Promise<{ balance_cents: number; currency?: string }>;
    createProject?: (name: string, kind: string, templateId?: string) => Promise<{ id: string; name: string }>;
    listProjects?: () => Promise<Array<{ id: string; name: string; kind: string }>>;
    sendNotification?: (title: string, body: string) => Promise<{ ok: boolean }>;
  };

  mcp?: AvosMcpRuntime;
  runSkill?: (skillName: string, args: Record<string, any>) => Promise<any>;
}

export interface HypervisorRouteResult {
  tier: ExecutionTier;
  binary: string;
  args: string[];
  requiresContainer: boolean;
  requiresBrowser: boolean;
  requiresWorkflow: boolean;
  suggestedBackend: "v8_isolate" | "kitesurf" | "chromium" | "workflow" | "container";
}

export interface MinimalistToolParams {
  command?: string;
  filePath?: string;
  offset?: number;
  limit?: number;
  oldString?: string;
  newString?: string;
  action?: "navigate" | "click" | "type" | "screenshot";
  url?: string;
  selector?: string;
  text?: string;
  targetRole?: string;
  taskDescription?: string;
  contextFiles?: string[];
}

export const MINIMALIST_AGENT_TOOLS = {
  Bash: {
    description:
      "Universal command-line execution interface. Runs shell utilities, scripts, virtual CLIs, and build/compilation dispatches with automated hypervisor routing.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The bash command or shell script line to execute." },
      },
      required: ["command"],
    },
  },
  Read: {
    description:
      "Line-numbered windowed file inspection. Supports line offsets and limits for context-window-safe inspection.",
    parameters: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Relative or absolute path to the file to inspect." },
        offset: { type: "number", description: "Starting line number (1-based, optional)." },
        limit: { type: "number", description: "Maximum number of lines to read (optional)." },
      },
      required: ["filePath"],
    },
  },
  Edit: {
    description:
      "Exact AST or string search-and-replace block edits. Forces surgical patching to prevent full-file rewrites.",
    parameters: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Path to the file to edit." },
        oldString: { type: "string", description: "Exact block of text to replace." },
        newString: { type: "string", description: "Replacement text to substitute in place of oldString." },
      },
      required: ["filePath", "oldString", "newString"],
    },
  },
  Browser: {
    description:
      "Web navigation, DOM accessibility tree extraction, form interactions, and visual screenshot capture.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["navigate", "click", "type", "screenshot"],
          description: "Action to perform in the browser.",
        },
        url: { type: "string", description: "Target URL to navigate to (required for navigate)." },
        selector: { type: "string", description: "CSS or XPath selector for click or type interactions." },
        text: { type: "string", description: "Text to type into the target element." },
      },
      required: ["action"],
    },
  },
  Delegate: {
    description:
      "Structured JSON-RPC task delegation to subagents or specialized sibling assistants.",
    parameters: {
      type: "object",
      properties: {
        targetRole: { type: "string", description: "Role or specialty of the target subagent." },
        taskDescription: { type: "string", description: "Detailed task instructions for the delegated agent." },
        contextFiles: {
          type: "array",
          items: { type: "string" },
          description: "List of relevant workspace file paths to attach.",
        },
      },
      required: ["targetRole", "taskDescription"],
    },
  },
} as const;

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

/**
 * One recorded run of a stored skill (see `ScriptMetadata.recent_outcomes`). The error is kept
 * on failures only, truncated — it is the input a repair is aimed at, not a log line.
 */
export interface SkillOutcome {
  ok: boolean;
  at: number;
  error?: string;
}

/** Recency verdict for a stored skill. Derived in skill-health.ts (all the logic lives there;
 *  the shape lives here so `FindCandidate` can carry it without a circular import). */
export type SkillHealthState = "unproven" | "proven" | "degrading" | "broken";

export interface SkillHealth {
  state: SkillHealthState;
  /** Failures at the head of the recent window — the streak, which is what actually predicts
   *  the next run. */
  consecutive_failures: number;
  recent_runs: number;
  recent_failures: number;
  /** The most recent failure's error, when there is one. What a repair is aimed at. */
  last_error?: string;
  /** One sentence written for the model, not for a dashboard. */
  recommendation: string;
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
  /**
   * Bounded rolling window of the most recent runs, newest first (see skill-health.ts).
   * `stability_score` is a lifetime ratio and cannot express recency — 20 successes and 4
   * failures scores the same whether those failures are spread over a year or are the last
   * four in a row. This is what makes "failed its last three runs, and here is what it said"
   * knowable, which is the difference between demoting a skill and repairing it.
   * Optional: absent on scripts written before this existed, which read as unproven.
   */
  recent_outcomes?: SkillOutcome[];

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
  /**
   * Who authored `error`: the MODEL (its own `give_up` reason, in its own words) or the
   * infrastructure around it (a gateway 429, a thrown exception, a budget gate).
   *
   * Load-bearing for the proactive loop, and found the hard way. A model that stops and explains
   * itself is describing a situation; it is not itself evidence that the situation is real. When
   * its prose was fed to classifyFailure like any other error string, a give_up that merely
   * MENTIONED running out of allowance was classified `quota_exhausted` — a kind whose whole
   * meaning is "this clears on its own, do not retry." The next wake-up's brief then told the
   * assistant its quota was spent, so it gave up again, and that give_up was classified the same
   * way. One genuine outage poisoned every future wake-up, permanently, long after capacity
   * returned — observed live: an assistant running fine on a completely different provider
   * refused to work because of a Workers AI failure from the previous day.
   */
  failure_origin?: "model" | "infrastructure";
}

/** A candidate returned by script.find. */
export interface FindCandidate {
  name: string;
  metadata: ScriptMetadata;
  semantic_similarity: number;
  /**
   * stability_score × semantic_similarity — "is this skill about the right thing?", with no
   * recency judgment folded in. The GATE tests THIS against the confidence floor, because a
   * broken skill is still the relevant one: reading it as "nothing found" would send the agent
   * off to write a second skill for a job it already has one for, instead of fixing that one.
   */
  relevance: number;
  /** relevance × health multiplier — "and can I trust it as it stands?". The sort key, so
   *  anything that actually works out-ranks something that has been failing. */
  confidence: number;
  /**
   * Recency verdict derived from `metadata.recent_outcomes` (skill-health.ts). Carried on the
   * candidate so the GATE can refuse to auto-run something broken and the reasoner can see WHY
   * — without either re-deriving it from raw counters.
   */
  health?: SkillHealth;
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
  /** "observe" | "find" | "gate" | "reason" | "run" | "answer" | "give_up" */
  phase: string;
  /** Script name, when the step concerns one (find top candidate, reason decision, run). */
  name?: string | undefined;
  tier?: number | undefined;
  duration_ms?: number | undefined;
  tokens?: number | undefined;
  ok?: boolean | undefined;
  detail?: string | undefined;
  /** A reasoning-capable model's own chain-of-thought for this "reason" step, when the model
   *  returned one — see billing-core's MODEL_CAPABILITIES doc header for which models this
   *  applies to. Rendered as a collapsed "Thoughts" block a user can expand, distinct from
   *  `detail` (which stays a short label like the chosen action). */
  thinking?: string | undefined;
  /** The live STATUS for this step's action — the model's own `doing` parameter, e.g. "Checking
   *  what's already in your store". Rendered beside the action while it runs and REPLACED by the
   *  next action's own, so a run of tool calls shows one status line rather than one per call.
   *  See GatewayReasoner.lastNarration. Distinct from `thinking` (collapsed internal reasoning)
   *  and from `message` (a real, permanent message — see below). */
  narration?: string | undefined;
  /** A real MESSAGE the model chose to write to the person on this step — its optional `say`
   *  parameter. Unlike `narration` this is never replaced: it renders as its own line in the
   *  conversation, in order, and a run reads as message → tool calls → message → tool calls
   *  (Claude Code's own shape). Present only on turns where the model judged one was warranted,
   *  which is what keeps a long run readable. See GatewayReasoner.lastMessage. */
  message?: string | undefined;
  /** For a "run" phase step: the exact arguments the tool was called with — what lets an
   *  expanded tool call show the real command, not just a duration. Attached at both the "begin"
   *  checkpoint (before the call resolves) and the "complete" one (unchanged). */
  params?: unknown;
  /** For a "run" phase step that succeeded: a size-capped, stringified view of the tool's raw
   *  return value (see loop.ts's `formatToolOutput`). A failed call's outcome lives in `detail`/
   *  `error` instead — this is only ever set on success. */
  output?: string | undefined;
  /** Date.now() at the moment the step was recorded. */
  ts: number;
}

/**
 * A live progress checkpoint — a TraceStep before it has a place in the trace, plus the two fields
 * that only make sense WHILE something is happening and are therefore never persisted.
 *
 * The distinction matters: `TraceStep` is the durable record of what a run did, read back long
 * after the fact from `run_traces`. This is the transient view of a run in flight, and it carries
 * text that is still growing — so a consumer has to know whether what it is holding is finished.
 */
export type LiveCheckpoint = Omit<TraceStep, "seq" | "ts"> & {
  /**
   * This checkpoint UPDATES the step already in flight rather than describing a new one — the
   * model is mid-sentence and this is the sentence so far. A consumer replaces its current step
   * in place instead of appending, or a single reasoning turn would produce dozens of rows.
   */
  partial?: boolean | undefined;
  /**
   * The final answer as it is being written, for a turn where the model chose to answer.
   *
   * Kept apart from `narration` because the two end up in different places on screen: narration is
   * a line inside the activity sequence, whereas this becomes the assistant's actual reply bubble.
   * Merging them would print the answer twice.
   */
  answer_preview?: string | undefined;
};

export interface LoopResult {
  level: EscalationLevel;
  script_name?: string;
  result?: ScriptRunResult;
  /** Set when a new/patched script was produced and queued for async compile. */
  distilled_script?: string;
  notes: string[];
  /** Structured per-phase/per-script.run trace (Phase HX1) — same run, richer than `notes`. */
  trace: TraceStep[];
  /**
   * Set only when the run stopped because a gated action is waiting on a human. This is NOT a
   * failure and must never be rendered as one: the work is intact, paused at the point just
   * before the gated action, and resumable once someone answers. `steps_completed` is what the
   * run had already done, carried so a resume can hand it back to the model rather than
   * re-deriving (or worse, re-executing) it.
   */
  pending_approval?: {
    approval_id: string;
    action_name: string;
    params: Record<string, unknown>;
    expires_at?: number;
    steps_completed: Array<{ name: string; params: Record<string, unknown>; ok: boolean; output?: unknown; error?: string }>;
  };
  /**
   * Actions parked mid-run because they need a human, on a run that CARRIED ON around them and
   * finished. Distinct from `pending_approval`, which is the whole run stopping: here the agent
   * did everything else it could, so there is a real answer AND some outstanding work.
   *
   * Blocking on the first thing that needs permission is what makes an agent useless in practice —
   * an assistant with five jobs stops dead on the one that needs a signature and stays stopped
   * until somebody happens to look. Each entry carries its own checkpoint so it resumes alone.
   */
  deferred_approvals?: Array<{
    approval_id: string;
    action_name: string;
    params: Record<string, unknown>;
    expires_at?: number;
    steps_completed: Array<{ name: string; params: Record<string, unknown>; ok: boolean; output?: unknown; error?: string }>;
  }>;
  /**
   * The ungated work this run completed, on EVERY exit — success, failure or exhaustion.
   *
   * A failed run used to hand back an error and nothing else, so the only thing a caller could
   * offer was "start over", which redoes side effects that already happened. With this, a failure
   * is resumable: the caller checkpoints these steps and a Continue picks up from them.
   */
  steps_completed?: Array<{ name: string; params: Record<string, unknown>; ok: boolean; output?: unknown; error?: string }>;
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
  /**
   * Assistant<->project-agent coordination lane (§A1.18 thread model). Unlike spawnSubAgent
   * (a throwaway, isolated child with no identity of its own), this dispatches to an EXISTING
   * named project agent definition, addressed the same way @mention dispatch does
   * (`{sessionId}:{agentId}`) so the two share the agent's normal per-thread memory/state — the
   * exchange lives in its own subthread (thread_kind='sub_agent', parent_thread_id), hidden by
   * default and expandable in the UI, never mixed into the visible user<->agent transcript.
   */
  consultAgent?(params: {
    agentId: string;
    message: string;
    spaceId: string;
    projectId?: string;
    parentThreadId?: string;
    threadId?: string;
  }): Promise<{
    ok: boolean;
    thread_id?: string;
    session_id?: string;
    reply?: string;
    error?: string;
  }>;
  /**
   * The other half of the §A1.18 thread model: post a message into an EXISTING, visible thread
   * (never a private sub_agent thread) and, unless `respond:false`, dispatch the named agent to
   * reply IN THAT SAME thread — what "chat with an ai inside the thread" looks like from the
   * assistant's side, as opposed to consultAgent's private, hidden coordination channel.
   */
  sendToThread?(params: {
    threadId: string;
    message: string;
    spaceId: string;
    agentId?: string;
    respond?: boolean;
    /** Run the replying agent on a specific model for this one dispatch. Omit to use that
     *  agent's own configured default. Valid ids come from sub-agent's agent.list_models. */
    model?: string;
  }): Promise<{
    ok: boolean;
    session_id?: string;
    reply?: string;
    dispatched: boolean;
    error?: string;
  }>;
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
  /**
   * A plain single-turn completion, for prebuilts that do their own small LLM work rather than
   * reasoning (today: project-journal compaction condensing old activity into an archive).
   * Optional — a caller without it degrades to that op's non-LLM fallback rather than failing,
   * matching how every other optional gateway in this file behaves.
   */
  complete?(args: { model: string; prompt: string; maxTokens?: number | undefined }): Promise<{
    text: string;
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
   *
   * Three outcomes, not two. `approved: false` means a human said no. `pending: true` means
   * nobody has answered YET and the request is still open — the run must suspend, not fail.
   * Collapsing those two into one boolean is what made "human in the loop" mean "the human has
   * a few seconds to answer or the action is refused": an owner who is asleep, at work, or
   * simply on another screen could never approve anything, and the agent reported their absence
   * as a refusal. An autonomous business that must ask before a payout or an ad spend cannot
   * work on that timescale.
   */
  requestApproval(params: {
    runId: string;
    sessionId: string;
    actionName: string;
    actionInput: Record<string, unknown>;
    description: string;
  }): Promise<{ approvalId: string; approved: boolean; pending?: boolean; expiresAt?: number; reason?: string }>;
}

/**
 * A record of actions that have actually been executed, so the same one is never executed twice.
 *
 * The gap this closes is replay. A run can be re-entered — a Workflow restart, or a resume after
 * someone approves a gated action hours later — and re-entering means the loop walks the task
 * again from the top. Handing the model its completed steps helps it not to repeat them, but
 * "the model should know better" is not a guarantee, and the cost of being wrong is a second
 * email, a second charge, a second payout.
 *
 * This is the ledger half of the durable-execution pattern (Palantir's Orchestrator names it
 * exactly that): an action is recorded when it runs, and a later attempt at the SAME action with
 * the SAME arguments under the SAME ledger key returns the recorded result instead of executing.
 * The ledger key is what ties an original run to its own resumes — a genuinely new run doing the
 * same work again is ordinary, and must not short-circuit.
 *
 * Optional: an unwired ledger degrades to today's behavior (the model's judgment plus the
 * within-run repeat guard), never to a blocked run.
 */
export interface ActionLedger {
  /** The recorded result of this exact action, if it has already run under this key. */
  lookup(key: string, actionName: string, paramsHash: string): Promise<ScriptRunResult | null>;
  /** Record an action that just executed. Never throws — a ledger write failure must not fail a
   *  run that already succeeded (the cost is a possible repeat on replay, not a lost result). */
  record(key: string, actionName: string, paramsHash: string, result: ScriptRunResult): Promise<void>;
}

/**
 * One committed step of the agent's own plan for THIS run — the Claude-Code-TodoWrite model, not
 * the durable per-project `tasks` DAG (which is for coordinating work ACROSS agents/runs and lives
 * in SpaceDO). A plan is run-scoped: it exists to keep a multi-step agent honest about finishing
 * what it said it would do before it stops. See the `plan` prebuilt and loop.ts's plan gate.
 */
export interface PlanStep {
  /** Stable id (an index-derived slug), so complete_step can name a specific step. */
  id: string;
  text: string;
  done: boolean;
}

/**
 * The live plan for the current run. A single mutable object shared by reference between the `plan`
 * prebuilt ops (which write it — plan.set/add_step/complete_step) and the loop (which reads it at
 * terminal-decision time to refuse a premature stop). Run-scoped: the loop creates it fresh per run
 * and reconstructs it from resumeSteps on a resume, so a plan set before an approval-suspend
 * survives the resume. Absent on env until the loop initializes it.
 */
export interface PlanState {
  steps: PlanStep[];
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
  /** The agents worker's own self-binding (AGENTS_WORKER). Lets a prebuilt reach an internal
   *  route on this same worker that holds a secret the isolate must never see — currently the
   *  business-email prebuilt calling /internal/business-email/{provision,send} for the AgentMail
   *  path (AGENTMAIL_API_KEY lives on the worker, not in the isolate env). */
  agentsWorker?: Fetcher;
  /** Billing worker — holds Lemon Squeezy creds + Naelao store; the only money-in path. */
  billingWorker?: Fetcher;
  /** MCP hub worker — registry + tool proxy for external-platform connectors (mcp-connector). */
  mcpHubWorker?: Fetcher;
  /** Credentials worker — the wallet prebuilt's check_bypass op reads a business's own
   *  credential list to detect a connected third-party payment provider. */
  credentialsWorker?: Fetcher;
  /** Artifact worker — agent-authored deliverables (rendered HTML, a report), space-scoped R2
   *  storage distinct from r2-workspace's own scratch files. The `artifacts` prebuilt degrades
   *  honestly when unbound. */
  artifactWorker?: Fetcher;
  /** Host-provided primitives for sub-agent / workflow prebuilt scripts. */
  orchestration?: OrchestrationHooks;
  /** HITL approval gateway — present when HITLApprovalDO is wired up. */
  hitlGateway?: HITLGateway;
  /** Exactly-once record of executed actions — present when the host provides one. See
   *  ActionLedger for why "the model can see it already ran" is not on its own a guarantee. */
  actionLedger?: ActionLedger;
  /**
   * The current run's plan (Claude-Code TodoWrite-style checklist) — a mutable object the loop
   * initializes at the start of every L3/L4 run and the `plan` prebuilt ops write to. Shared by
   * reference so the loop can enforce "don't stop with incomplete plan steps" against the SAME
   * state the model updated. Set by runScriptLoop, never by the host — a caller/test that never
   * runs the loop leaves it absent, and the plan ops degrade to a clear "no active run" message.
   */
  plan?: PlanState;
  /**
   * Called after a project workspace file is written or removed, so the host can fire a
   * `workspace.file_changed` event.
   *
   * This is what turns a file into a handoff between projects: the lead-generation agent records
   * a customer, that write fires the event, and a no-code rule wakes the agent that owns the next
   * stage. Passing the work as an event payload instead would leave the receiving agent with only
   * a message to remember — a file is state both sides can re-read, and it outlives the run that
   * produced it.
   *
   * Fire-and-forget by contract: the write has already succeeded by the time this is called, and
   * a listener failing must never turn it into a failure. Absent when the host wires no events.
   */
  onWorkspaceChange?: (change: { path: string; operation: "write" | "delete" }) => void;
  /** Runs the SAME Memory OS maintenance pass (decay/promote/prune) the client-driven
   *  POST .../sessions/:id/compact HTTP route triggers — as a tool the model itself can call mid-
   *  run (see the `memory` prebuilt's `memory.compact` op), not only from the shell UI. Present
   *  whenever the host DO wires it (always, in practice — see NaelaoAgentDO.buildScriptEngineEnv);
   *  the op degrades honestly rather than throwing when it isn't. */
  compactMemory?: () => Promise<unknown>;
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
   * §A1 connector default-vs-personal switch: this session's chosen mode per connector id
   * ("business" — the default, use the shared account; "personal" — require the caller's own
   * connected account, refuse rather than silently fall back). Read once by NaelaoAgentDO at run
   * start (best-effort GET to SpaceDO's connector-mode store) and forwarded by the mcp-connector
   * prebuilt as `x-naelao-connector-scope` on each mcp-hub call for the referenced server. Absent
   * entries (the common case — most connectors never had a user switch away from business) mean
   * "resolve exactly as before this feature existed."
   */
  connectorAccountMode?: Record<string, "business" | "personal">;
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
  /**
   * Progressive tool disclosure (Phase 2 item 13) — when true, `available_operations` in the
   * reasoner payload is REDUCED to a small always-visible core set plus `tools.search`/
   * `tools.describe` for discovering the rest, instead of the full grouped dump every turn.
   * Execution itself is UNCHANGED either way — script.run still accepts any enabled operation
   * regardless of whether it was shown, so this can only ever shrink the payload, never block a
   * valid call. Default false (absent) = today's full-disclosure behavior, byte-identical.
   * Deliberately NOT default-on anywhere yet: this session's own history (items 133-139) is a
   * record of how fragile this exact reasoning-loop surface is on the platform's small models,
   * so this ships opt-in per space/run until proven live on a real business. See
   * ScriptToolSurface.disclosureGroups' own doc for the automatic full-disclosure fallback.
   */
  progressiveToolDisclosure?: boolean;
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

/** Helper returning the base user-facing workspace prefix R2 path. */
export function getWorkspacePath(spaceId: string, projectId?: string): string {
  return projectId
    ? `spaces/${spaceId}/projects/${projectId}/workspace/`
    : `spaces/${spaceId}/workspace/`;
}

/** Helper returning the internal AVOS system meta-state R2 prefix path. */
export function getAvosInternalPath(spaceId: string, projectId?: string): string {
  return projectId
    ? `spaces/${spaceId}/projects/${projectId}/.avos/`
    : `spaces/${spaceId}/.avos/`;
}

/** Authoritative AVOS internal file path conventions. */
export const AVOS_PATH_CONVENTIONS = {
  sharedSkills: ".avos/shared/skills/",
  sharedWorkflows: ".avos/shared/workflows/",
  agentSoul: (agentId: string) => `.avos/agents/${agentId}/SOUL.md`,
  agentMemory: (agentId: string) => `.avos/agents/${agentId}/memory.json`,
  agentScratchpad: (agentId: string) => `.avos/agents/${agentId}/scratchpad/`,
};
