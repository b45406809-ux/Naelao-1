/**
 * The script-first loop (spec §2) + escalation ladder (spec §5), implemented as the agent
 * behavior that runs inside NaelaoAgentDO.
 *
 *   OBSERVE → FINGERPRINT → FIND → GATE → EXECUTE → VERIFY → DISTILL
 *
 * The reasoning model only participates in GATE→DIAGNOSE/REASON and DISTILL; every other
 * step is a script call with no model tokens. Token spend scales with novelty.
 *
 * The model is injected as a `Reasoner` so this loop is decoupled from the AI client and
 * unit-testable. The host (NaelaoAgentDO) wires a concrete Reasoner over the AI Gateway.
 */

import type { ConversationContext } from "./conversation-context.js";
import type {
  ScriptEngineEnv,
  ObserveSnapshot,
  LoopResult,
  FindCandidate,
  ScriptMetadata,
  EscalationLevel,
  HITLGateway,
  TraceStep,
  LiveCheckpoint,
  ScriptRunResult,
} from "./types.js";

/** LoopResult before the shared trace array is attached — see `finish()` in runScriptLoop. */
type LoopResultCore = Omit<LoopResult, "trace">;

/** Records one structured trace step. Bound to a specific run's `trace` array by closure. */
type PushTrace = (step: Omit<TraceStep, "seq" | "ts">) => void;
import { ScriptToolSurface } from "./tool-surface.js";
import { runObserve } from "./observe.js";
import { assessBudget, resolveLoopBudget, isContextOverflowError, type LoopBudget } from "./loop-budget.js";
import { compactSteps, stepLimitsForModel, squeezeStepLimits } from "./step-context.js";
import { fingerprintSimilarity, isMatch, isPartial } from "./fingerprint.js";
import { FIND_CONFIDENCE_FLOOR } from "./script-find.js";
import { assessSkillHealth, isSafeToAutoRun } from "./skill-health.js";
import { applyPlanOp } from "./prebuilt/plan.js";
import type { PlanState } from "./types.js";
import { runAfterStep, runBeforeStep, type StepPipeline } from "./step-pipeline.js";

/**
 * Rebuild the run's plan from its recorded history — used at the start of a RESUMED run, where the
 * original run's plan.* calls are in resumeSteps (shown to the model as done work) but were not
 * re-executed, so env.plan would otherwise be empty and the plan gate would let a half-finished
 * plan slip through on resume. Replays every recorded plan.* call through the SAME applyPlanOp the
 * live ops use, so a reconstructed plan is identical to the one the original run held. A fresh run
 * (empty resumeSteps) yields an empty plan.
 */
function reconstructPlanFromSteps(
  steps: Array<{ name: string; params: Record<string, unknown> }>
): PlanState {
  const state: PlanState = { steps: [] };
  for (const s of steps) {
    if (s.name.startsWith("plan.")) applyPlanOp(state, s.name, s.params);
  }
  return state;
}

/** How many consecutive times the loop will refuse a premature terminal decision (a stop with an
 *  incomplete plan) before it gives up enforcing and lets the run end. This is belt-and-suspenders
 *  on top of the stall budget (a refusal is a non-progress step and counts toward maxStallSteps
 *  anyway) — it guarantees the plan gate can never itself run a plan to the 50-step runaway
 *  ceiling if the model simply refuses to either finish or mark its steps. */
const MAX_PLAN_GATE_REFUSALS = 6;

/**
 * LEGACY FALLBACK ONLY (spec §11). The enforced source of truth is the structural
 * `AgentConfig.requiresApprovalFor` field (agent-config.ts, persisted in scripts.json and
 * written by `launchpadAgentToProfile` from `def.requires_approval_for`) — no agent-authoring
 * path writes a `## requires_approval_for` markdown heading into agents.md anymore (the
 * human-readable "# Approval Gates (HITL)" section is prose for the model, not this parser).
 * Callers should use `config.requiresApprovalFor` and only fall back to parsing agents.md via
 * this function for agents provisioned before the structural field existed.
 *
 * Parse the `requires_approval_for:` section from agents.md.
 * Looks for a fenced block or a yaml-list after the heading, e.g.:
 *   ## requires_approval_for
 *   - delete_file
 *   - send_email
 */
export function parseRequiresApprovalFor(agentsMd: string): Set<string> {
  const result = new Set<string>();
  const match = agentsMd.match(/##\s*requires_approval_for\s*\n((?:[ \t]*-[ \t]+\S+\s*\n?)+)/i);
  if (!match?.[1]) return result;
  for (const line of match[1].split("\n")) {
    const item = line.replace(/^\s*-\s*/, "").trim();
    if (item) result.add(item);
  }
  return result;
}

/**
 * Whether `gatedActions` blocks `actionName`, under the run's approval mode:
 *   - "gate_listed" (default — ordinary project-bound Naelao Agents): gatedActions is an
 *     ALLOWLIST of what's gated. Everything else runs freely. This is agents.md's
 *     `requires_approval_for:` block — a builder opts specific actions INTO approval.
 *   - "gate_unless_listed" (the Space Assistant's default posture): gatedActions is an
 *     ALLOWLIST of what's PRE-APPROVED. Everything else is gated by default — "same access
 *     as the owning user, but ask first unless the user has explicitly trusted this action."
 */
export function isGated(actionName: string, gatedActions: Set<string>, mode: ApprovalMode): boolean {
  return mode === "gate_unless_listed" ? !gatedActions.has(actionName) : gatedActions.has(actionName);
}

/** What the gate decided. `pending` is the state a two-valued gate could not express: nobody has
 *  answered yet, the request is still open, and the run should suspend rather than fail. */
type GateOutcome =
  | { verdict: "proceed" }
  | { verdict: "denied"; reason?: string }
  | { verdict: "pending"; approvalId: string; expiresAt?: number };

/**
 * Gate an action against the HITL policy.
 * When hitlGateway is absent, the action isn't gated under the current mode, or the action was
 * already approved on a previous pass of a suspended run, execution proceeds.
 */
async function hitlGate(
  actionName: string,
  actionInput: Record<string, unknown>,
  gatedActions: Set<string>,
  mode: ApprovalMode,
  gateway: HITLGateway | undefined,
  runId: string,
  sessionId: string,
  notes: string[],
  preApproved: Set<string>
): Promise<GateOutcome> {
  if (!isGated(actionName, gatedActions, mode) || !gateway) return { verdict: "proceed" };
  // A human already said yes to exactly this action on the pass that suspended — asking again
  // would make an approved action unapprovable, since every resume would re-open a new request.
  if (preApproved.has(actionName)) {
    notes.push(`HITL: '${actionName}' was approved before this resume → proceeding`);
    return { verdict: "proceed" };
  }
  notes.push(`HITL gate: requesting approval for '${actionName}'`);
  const { approved, pending, expiresAt, reason, approvalId } = await gateway.requestApproval({
    runId,
    sessionId,
    actionName,
    actionInput,
    description: `The agent wants to run '${actionName}'. Review the parameters and approve or reject.`,
  });
  if (approved) {
    notes.push(`HITL ${approvalId}: approved → proceeding`);
    return { verdict: "proceed" };
  }
  if (pending) {
    notes.push(`HITL ${approvalId}: awaiting a human → suspending the run (nothing was executed)`);
    return { verdict: "pending", approvalId, ...(expiresAt ? { expiresAt } : {}) };
  }
  notes.push(`HITL ${approvalId}: rejected (${reason ?? "no reason"}) → aborting action`);
  return { verdict: "denied", ...(reason ? { reason } : {}) };
}

/** The user-facing reason a gated action didn't run.
 *
 * "HITL rejected" alone is genuinely ambiguous, and that ambiguity cost real debugging time: a
 * failed assistant-policy fetch fails CLOSED (by design), so an infrastructure blip produces the
 * exact same message as a human deliberately declining. Naming the action, and the fact that
 * approval was required, at least tells the reader which of the two they're looking at. */
function gateRejectedMessage(actionName: string): string {
  return `'${actionName}' needed approval and was not approved (either declined, or no approver was reachable)`;
}

/** A decision the reasoning model returns when the library has no ready answer. */
export type ReasonDecision =
  | { action: "run"; name: string; params: Record<string, unknown> }
  | { action: "patch"; name: string; code: string; reason: string }
  | { action: "distill"; name: string; code: string; metadata: Partial<ScriptMetadata>; params: Record<string, unknown> }
  | { action: "answer"; text: string }
  | {
      action: "give_up";
      reason: string;
      /**
       * Whose failure this is. Only set to "model" when the MODEL itself chose to stop and these
       * are its own words — see ScriptRunResult.failure_origin for why that must never be
       * pattern-matched as infrastructure evidence.
       *
       * Absent means infrastructure, deliberately: the reasoner reports its own failures
       * (a gateway 429, an unparseable reply, a stream that died) through this same give_up
       * channel, and those must keep classifying exactly as they always have. Defaulting the
       * other way silently swallowed a real Gemini 429 into `unknown` — caught live, one run
       * after the fix that introduced it.
       */
      origin?: "model" | "infrastructure";
    };

/** Real LLM token usage from one decide() call (spec: per-token accounting, not a step-count
 *  proxy). Read from `Reasoner.lastUsage` immediately after each awaited decide() — safe
 *  because the loop never overlaps two decide() calls on the same reasoner instance. */
export interface ReasonerUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface Reasoner {
  /**
   * Decide what to do given the goal, the current observation, find candidates, and the
   * available prebuilt operations. Used for L2/L3/L4.
   */
  decide(input: {
    goal: string;
    level: EscalationLevel;
    snapshot: ObserveSnapshot;
    candidates: FindCandidate[];
    availableOperations: string[];
    /**
     * The same operations as `availableOperations`, grouped by owning prebuilt script with that
     * script's own description — see ScriptToolSurface.availableOperationsGrouped's doc for why
     * a flat name list alone left real capabilities (e.g. thread.send_message) undiscoverable.
     * Optional so a caller/test that only has the flat list still works; reasoner.ts prefers this
     * when present.
     *
     * Callers pass ScriptToolSurface.disclosureGroups() here, not availableOperationsGrouped()
     * directly — the two are identical unless progressive tool disclosure is opted in for this
     * run (ScriptEngineEnv.progressiveToolDisclosure), in which case this is a REDUCED set plus
     * tools.search/tools.describe for finding the rest. See disclosureGroups()'s own doc.
     */
    operationGroups?: Array<{
      script: string;
      description: string;
      operations: string[];
      /** opName → one-line parameter hint, when the owning script declares one — see
       *  PrebuiltScript.paramHints's own doc for why this exists (a bare op name plus a
       *  script-level description was not enough for a model to know what fields a call needs). */
      paramHints?: Record<string, string>;
    }>;
    /** Signature-only catalog assembled at turn start; never contains implementation source. */
    activeCatalog?: string;
    /** Set on L2/L3 — the script being repaired and why it drifted. */
    repairTarget?: { name: string; failureReason: string };
    /**
     * What this run has already done and what came back, oldest first.
     *
     * Without this the model is blind to its own tool output: it could only ever fire one call
     * and never react to the result, which makes "look this up, then decide" — the shape of most
     * real work — impossible. Passing observations back is what turns a single dispatch into an
     * actual agent loop.
     */
    priorSteps?: Array<{ name: string; params: Record<string, unknown>; ok: boolean; output?: unknown; error?: string }>;
    /**
     * One line per step folded out of `priorSteps` to keep the payload inside the model's context
     * window — what ran, with what arguments, and how it went (step-context.ts).
     *
     * This is what lets the loop run past the point where raw history would overflow. Without it
     * the step count could not exceed roughly a dozen on the small-window models this platform
     * actually runs on, which is the real reason the loop used to be capped at six.
     */
    earlierSteps?: string[];
    /**
     * The thread's own conversation so far, bounded and possibly compacted.
     *
     * Without it the agent has no memory of the thread it is replying in: it cannot resolve
     * "do that again", cannot answer "what did we decide", and re-asks things the user already
     * told it. When `compacted` is set the model is told so explicitly and pointed at
     * conversation.search, rather than being left to answer confidently from a partial record.
     */
    conversation?: ConversationContext;
    /**
     * This is the last step available — there is no next turn to answer in, so the model must
     * finish now (`answer`, or `give_up` if it genuinely cannot). Set only on the final iteration.
     *
     * Without it a model that keeps choosing `run` falls off the end of the loop and the run is
     * reported as "never reached an answer" even when its tool calls all succeeded, which reads to
     * the user as a failure of work that actually happened.
     */
    finalStep?: boolean;
    /**
     * The loop's own real-time progress on THIS run — passed on EVERY L3/L4 turn, not just the
     * final one. Previously the model had no way to see this at all: it found out it was almost
     * out of budget only via `finalStep` on the very last turn, and was never told how many of its
     * own actions had actually succeeded versus failed along the way. That meant the only way a
     * run ever stopped early was by being cut off externally (a generic "ran out of steps"), never
     * by the model itself recognizing "I've tried three approaches to this and none worked" and
     * saying so.
     *
     * With this, a model that notices several actions in a row have failed or gone nowhere can
     * `give_up` on its own initiative, WITH a real explanation of what it tried — which is a much
     * more useful thing for a person to read than a budget-exhaustion message they can't act on.
     * It can also see it still has plenty of room left and keep working confidently rather than
     * rushing to answer early.
     */
    progress?: {
      /** 1-based: which step this is. */
      step: number;
      /** The runaway ceiling (loop-budget.ts) — NOT a target to spend, just where the hard stop is. */
      max_steps: number;
      /** Actions that actually ran and succeeded so far this run. */
      successful_actions: number;
      /** Actions that ran and failed, INCLUDING ones parked pending human approval. */
      failed_actions: number;
      /** Consecutive steps in a row with no successful result — see LoopBudget.maxStallSteps. */
      stall_steps: number;
      max_stall_steps: number;
      tokens_used: number;
      max_tokens?: number;
    };
    /**
     * The agent's own committed plan for this run (the `plan` prebuilt), present only once at least
     * one step has been set. Passed on every turn so a plan survives history compaction — the model
     * can always see exactly what it committed to and which steps remain. The loop enforces it:
     * a terminal answer/give_up is refused while any step is still open (see the plan gate in the
     * L3/L4 body). Absent for agents that never set a plan — every existing agent is unaffected.
     */
    plan?: {
      total: number;
      completed: number;
      remaining: number;
      steps: Array<{ id: string; text: string; done: boolean }>;
    };
    /**
     * Called repeatedly WHILE the model is generating, with whatever user-visible text has
     * arrived so far — the mid-run reply it is writing (`say`) or the final answer it is
     * composing (`answer`). Each call carries the CUMULATIVE value, not an incremental fragment,
     * so a dropped update can never corrupt what the reader sees.
     *
     * Present only when someone is actually watching: an interactive chat passes it, while a cron
     * wake, a channel drain and a sub-agent do not — and a reasoner that receives none takes the
     * cheaper non-streamed path. That is deliberate. Streaming costs an extra connection held open
     * for the duration of the call, and there is no point paying it for a run whose output nobody
     * will see until it is finished anyway.
     */
    onDelta?: (partial: { doing?: string | undefined; say?: string | undefined; answer?: string | undefined }) => void;
  }): Promise<ReasonDecision>;
  /** Token usage from the most recently completed decide() call, when the backing LLM
   *  client reports it. Optional — reasoners that can't report it (e.g. test fakes) leave
   *  this undefined, which the loop treats as zero, not an error. */
  lastUsage?: ReasonerUsage | undefined;
  /** The model's own chain-of-thought from the most recently completed decide() call, when the
   *  model/provider returned one (a reasoning-capable model with a reasoning level chosen — see
   *  billing-core's MODEL_CAPABILITIES). Optional — most reasoners/models never set this. */
  lastThinking?: string | undefined;
  /** The live status for the action the most recent decide() chose ("Checking your existing
   *  projects") — replaced by the next action's own, never accumulated. See
   *  GatewayReasoner.lastNarration. Optional — most reasoners/models never set this. */
  lastNarration?: string | undefined;
  /** A real message the model chose to write to the person on the most recent decide(), kept
   *  permanently rather than replaced. See GatewayReasoner.lastMessage for why this is captured
   *  separately from lastNarration. Optional — set only on the turns that warrant one. */
  lastMessage?: string | undefined;
}

/** Escalation thresholds (spec §11.1 agents.md "Escalation Rules"). Overridable per agent. */
export interface EscalationConfig {
  stabilityFloorForL1: number; // L1 only if stability_score > this and fingerprint matches
  maxPatchesBeforeL3: number; // L3 if patch_history.length >= this
  fingerprintTolerance: number;
  confidenceFloor: number; // below this → no match → L4
}

export const DEFAULT_ESCALATION: EscalationConfig = {
  stabilityFloorForL1: 0.7,
  maxPatchesBeforeL3: 5,
  fingerprintTolerance: 0.05,
  confidenceFloor: FIND_CONFIDENCE_FLOOR,
};

/** See RunLoopOptions.approvalMode. */
export type ApprovalMode = "gate_listed" | "gate_unless_listed";

/**
 * Context window assumed when the caller doesn't say which model is running.
 *
 * Deliberately the SMALL end of the range this platform actually serves, not a comfortable
 * average: the cost of assuming too little is a slightly shorter history than necessary, and the
 * cost of assuming too much is every call failing on overflow. `contextWindowTokens` should
 * always be passed in practice (NaelaoAgentDO resolves it from the run's real model).
 */
const DEFAULT_ASSUMED_CONTEXT_WINDOW = 24_000;

/** How many times a context-overflow error may force a harder squeeze before it's taken at face
 *  value. Two is enough to halve the history twice; a third failure is not a sizing problem. */
const MAX_OVERFLOW_RETRIES = 2;

export interface RunLoopOptions {
  pipeline?: StepPipeline;
  goal: string;
  startupObserve: string;
  observeArgs?: Record<string, unknown>;
  escalation?: Partial<EscalationConfig>;
  /**
   * Runaway ceiling on EXECUTE attempts within one pass. NOT an operating limit — see
   * loop-budget.ts's DEFAULT_LOOP_BUDGET. Sub-agents set their own, derived from their token
   * budget; the interactive path leaves it at the default and is bounded by tokens and time.
   */
  maxSteps?: number;
  /**
   * Real per-token budget ceiling for this pass (spec: sub-agent budgets must be enforced
   * against actual reasoner token spend, not a coarse step-count proxy). Checked before each
   * L3/L4 reasoning step; once reached the loop stops taking new steps and falls through to
   * the same "exhausted" terminal handling as running out of maxSteps. Absent = unbounded
   * (the normal builder-workspace default; sub-agents always set this from their own budget).
   */
  maxTokens?: number;
  /**
   * Epoch ms after which no new step may start.
   *
   * The interactive path sets this because a person is waiting on the other end of a request; the
   * durable path leaves it off, since a Cloudflare Workflow step has no wall-time limit and the
   * enclosing job owns that decision. One turn before the deadline the model is told to wrap up,
   * so running out of time produces a real answer about what was done rather than a timeout.
   */
  deadlineAt?: number;
  /** Consecutive steps with no successful tool result before the loop stops and asks for a
   *  summary. See LoopBudget.maxStallSteps. */
  maxStallSteps?: number;
  /**
   * The real context window of the model this run is using, in tokens — used to size how much of
   * the run's own history is carried forward each turn (step-context.ts).
   *
   * Load-bearing rather than a nicety: this platform's default model is served with a 24k window
   * against a nominal 128k (billing-core's MODEL_CONTEXT_WINDOWS, read from the account's own
   * model API). Sizing history against the nominal figure would overflow it.
   */
  contextWindowTokens?: number;
  /**
   * Action names interpreted according to `approvalMode` (default "gate_listed"):
   *   - "gate_listed": these are the actions that REQUIRE approval (agents.md's
   *     `requires_approval_for:` block) — everything else runs freely. The normal posture
   *     for an ordinary, narrower-purpose Naelao Agent.
   *   - "gate_unless_listed": these are the actions PRE-APPROVED to skip asking — everything
   *     else requires approval by default. The Space Assistant's posture: same access as the
   *     user who owns it, but ask first unless the user has explicitly trusted this action
   *     (an empty list + this mode = ask before literally everything; a non-empty list here
   *     with an absent hitlGateway, or "yolo" policy passing an empty gate_listed set, is how
   *     a user grants full autonomy — see NaelaoAgentDO.fetchAssistantPolicy).
   * When env.hitlGateway is present and the chosen action is gated under the current mode,
   * the loop pauses and waits for HITLApprovalDO to resolve it before running.
   */
  requiresApprovalFor?: string[];
  approvalMode?: ApprovalMode;
  /**
   * Resuming a run that suspended waiting on a human: the actions a human has since approved.
   * The gate lets these through once without re-asking — otherwise every resume would open a
   * fresh approval request for the very action that was just approved, and no gated action
   * could ever run.
   */
  preApprovedActions?: string[];
  /**
   * Ties an original run to its own resumes for the action ledger. A resume mints a fresh runId
   * (so its trace is separately readable), which would otherwise make every already-executed
   * action look brand new to the ledger and let a replay redo it. Defaults to `runId`, so a
   * first-time run is keyed by itself and a genuinely new run never short-circuits another's work.
   */
  ledgerKey?: string;
  /**
   * Resuming: what the suspended pass had already executed. Handed to the model as its
   * steps-so-far so it can build on that work instead of repeating it. The gated action itself
   * is never in here — the whole point of suspending at the gate is that it had not run.
   */
  resumeSteps?: Array<{ name: string; params: Record<string, unknown>; ok: boolean; output?: unknown; error?: string }>;
  /** Opaque run/session identifiers forwarded to the HITL gateway. */
  runId?: string;
  sessionId?: string;
  /**
   * The thread's conversation so far, bounded and possibly compacted. Forwarded verbatim to
   * every reasoning step so the agent has memory of the thread it is replying in — absent for a
   * first message or a non-conversational wake (cron, channel drain).
   */
  conversation?: ConversationContext;
  /**
   * Optional checkpoint callback (spec: incremental sub-agent progress — a parent shouldn't
   * have to wait for a whole child run to finish to see it's alive and making progress; also the
   * host's hook for a live "currently doing X" activity feed in a chat UI, e.g. Claude Code's own
   * "Thinking…"/tool-call display).
   *
   * Fired twice per phase: once right before a slow operation starts (name/detail set, `ok`
   * absent — "in flight"), and once automatically from `pushTrace` when it completes (the same
   * shape persisted to `LoopResult.trace`, `ok`/`tokens`/`duration_ms` now populated) — so a host
   * with no live-progress needs can simply ignore the checkpoints and only read the final
   * `LoopResult.trace`, while one that wants live status gets it for free from the same callback.
   * Never awaited into the critical path failing the run — a throwing onProgress is swallowed,
   * not propagated.
   */
  onProgress?: (checkpoint: LiveCheckpoint) => void | Promise<void>;
  /**
   * Has someone asked for this run to stop?
   *
   * Cooperative on purpose: a loop mid-way through a tool call cannot be torn down safely — the
   * side effect it is performing (an email, a payment, a created project) either happens or does
   * not, and killing it partway leaves nobody able to say which. So the run finishes the action it
   * is in and stops at the NEXT step boundary, reporting the work it genuinely completed.
   *
   * Checked once per step. Absent for every non-interactive caller (cron, channel drain,
   * sub-agent), which have no one watching to press a button.
   */
  shouldCancel?: () => boolean | Promise<boolean>;
}

async function reportProgress(opts: RunLoopOptions, checkpoint: LiveCheckpoint): Promise<void> {
  if (!opts.onProgress) return;
  try {
    await opts.onProgress(checkpoint);
  } catch {
    /* progress reporting is a convenience, never fails the run */
  }
}

/**
 * The bridge from "the model is generating" to "the person can read it".
 *
 * Returns the callback handed to `reasoner.decide` so each partial arrives as a live checkpoint
 * updating the in-flight reason step, or undefined when nobody is watching — which is also the
 * signal the reasoner uses to skip streaming entirely and take the cheaper path.
 */
function deltaReporter(
  opts: RunLoopOptions
): ((p: { doing?: string | undefined; say?: string | undefined; answer?: string | undefined }) => void) | undefined {
  if (!opts.onProgress) return undefined;
  return (p) => {
    void reportProgress(opts, {
      phase: "reason",
      detail: "Thinking",
      partial: true,
      ...(p.doing ? { narration: p.doing } : {}),
      ...(p.say ? { message: p.say } : {}),
      ...(p.answer ? { answer_preview: p.answer } : {}),
    });
  };
}

/**
 * Run one goal through the loop. Returns the chosen escalation level, the result, and any
 * distilled/patched script that was produced. DISTILL persists a draft synchronously; the
 * full compile (rich metadata, embedding refresh) is meant to run async (spec §16
 * "The Compile Step as a Scheduled Task") — the host can pick up the draft and finalize it.
 */
export async function runScriptLoop(
  env: ScriptEngineEnv,
  tools: ScriptToolSurface,
  reasoner: Reasoner,
  enabledPrebuilt: string[],
  opts: RunLoopOptions
): Promise<LoopResult> {
  const cfg: EscalationConfig = { ...DEFAULT_ESCALATION, ...opts.escalation };
  const notes: string[] = [];
  const gatedActions = new Set(opts.requiresApprovalFor ?? []);
  const approvalMode: ApprovalMode = opts.approvalMode ?? "gate_listed";
  const runId = opts.runId ?? crypto.randomUUID();
  const sessionId = opts.sessionId ?? "unknown";
  const preApproved = new Set(opts.preApprovedActions ?? []);
  const ledgerKey = opts.ledgerKey ?? runId;

  /**
   * Run an action, unless the ledger says it already ran under this key — in which case return
   * what it returned then. This is what makes re-entering a run safe rather than merely likely to
   * be safe: on a resume the model is shown its completed steps, but showing is not preventing.
   */
  const runOnce = async (name: string, params: Record<string, unknown>): Promise<ScriptRunResult> => {
    const injected = await runBeforeStep(opts.pipeline, env.pipelineRuntime);
    if (injected.length) notes.push(`pipeline context: ${JSON.stringify(injected).slice(0, 2000)}`);
    const ledger = env.actionLedger;
    delete env.lastWorkspaceCommitOid;
    if (!ledger) {
      const result = await tools.run(name, params);
      const verification = result.ok ? await runAfterStep(opts.pipeline, env.pipelineRuntime) : { ok: true, failures: [] };
      const verified = verification.ok ? result : { ...result, ok: false, error: `post-step verification failed: ${JSON.stringify(verification.failures)}` };
      return env.lastWorkspaceCommitOid ? { ...verified, commit_oid: env.lastWorkspaceCommitOid } : verified;
    }
    const paramsHash = stableStringify(params);
    try {
      const recorded = await ledger.lookup(ledgerKey, name, paramsHash);
      if (recorded) {
        notes.push(`ledger: '${name}' already ran under this task — returning the recorded result`);
        pushTrace({ phase: "run", name, ok: recorded.ok, detail: "replayed from ledger", tier: recorded.tier });
        return recorded;
      }
    } catch {
      // A ledger that can't be read must not block real work. The exposure is a possible repeat
      // on replay — the same risk as having no ledger at all, which is where this started.
    }
    let result = await tools.run(name, params);
    if (result.ok) { const verification = await runAfterStep(opts.pipeline, env.pipelineRuntime); if (!verification.ok) result = { ...result, ok: false, error: `post-step verification failed: ${JSON.stringify(verification.failures)}` }; }
    if (env.lastWorkspaceCommitOid) result = { ...result, commit_oid: env.lastWorkspaceCommitOid };
    if (result.ok) {
      try {
        await ledger.record(ledgerKey, name, paramsHash, result);
      } catch { /* recorded-or-not, the action really happened; never fail the run over the write */ }
    }
    return result;
  };

  // Phase HX1: structured per-step trace, the persisted counterpart to `notes`. `finish()`
  // attaches the accumulated `trace` array to whichever LoopResultCore a return site produces —
  // every return in this function goes through it so no exit path is untraced.
  const trace: TraceStep[] = [];
  let traceSeq = 0;
  const pushTrace: PushTrace = (step) => {
    trace.push({ seq: traceSeq++, ts: Date.now(), ...step });
    // Fire-and-forget: this is what gives a live activity feed the COMPLETED half of every
    // phase (ok/tokens/duration_ms filled in) with zero extra call sites — see onProgress's doc.
    if (opts.onProgress) void reportProgress(opts, step);
  };

  /** A size-capped, stringified view of a tool's raw return value — what lets the activity feed
   *  show "the command and its result" (Claude Code's own cmd-tool view) instead of only a
   *  duration/token count. Capped so one large tool result can never bloat run_traces or the live
   *  progress payload; a failure result already has its own message in `error`/`detail`, so this
   *  is only ever attached on success. */
  const OUTPUT_CAP = 4000;
  const formatToolOutput = (output: unknown): string | undefined => {
    if (output === undefined) return undefined;
    try {
      const text = typeof output === "string" ? output : JSON.stringify(output);
      return text.length > OUTPUT_CAP ? `${text.slice(0, OUTPUT_CAP)}\n… (truncated)` : text;
    } catch {
      return undefined;
    }
  };
  /** Parked-for-approval actions accumulated by the L3/L4 block, attached by finish() to whichever
   *  exit the run takes — so a run that answered around a parked action still reports it, rather
   *  than the outstanding work quietly disappearing with the reply. */
  let deferredOut: NonNullable<LoopResult["deferred_approvals"]> = [];
  /** The ungated work this run actually completed, attached to EVERY exit — including a failure.
   *
   *  Without it a failed run is unresumable: the caller has an error and nothing else, so the only
   *  offer it can make is "start over", which redoes side effects that already happened. This is
   *  the same payload the suspend path already hands back as `pending_approval.steps_completed`;
   *  a run that fails deserves it just as much as a run that stops for a human. */
  let stepsOut: NonNullable<LoopResult["steps_completed"]> = [];
  const finish = (r: LoopResultCore): LoopResult => ({
    ...r,
    trace,
    ...(deferredOut.length > 0 ? { deferred_approvals: deferredOut } : {}),
    ...(stepsOut.length > 0 ? { steps_completed: stepsOut } : {}),
  });

  /** A run that stopped at the gate, waiting on a human. Deliberately NOT an error result: the
   *  work so far is intact and the action is still pending, so the caller persists a checkpoint
   *  and resumes rather than reporting a failure the user has to redo. */
  const suspend = (
    level: EscalationLevel,
    gate: { verdict: "pending"; approvalId: string; expiresAt?: number },
    actionName: string,
    params: Record<string, unknown>,
    stepsCompleted: Array<{ name: string; params: Record<string, unknown>; ok: boolean; output?: unknown; error?: string }>
  ): LoopResult => {
    pushTrace({ phase: "gate", name: actionName, detail: "awaiting_approval", params });
    return finish({
      level,
      script_name: actionName,
      notes,
      pending_approval: {
        approval_id: gate.approvalId,
        action_name: actionName,
        params,
        ...(gate.expiresAt ? { expires_at: gate.expiresAt } : {}),
        steps_completed: stepsCompleted,
      },
    });
  };

  // 1-2. OBSERVE + FINGERPRINT
  await reportProgress(opts, { phase: "observe", detail: "Observing current state" });
  const observeStart = Date.now();
  const snapshot = await runObserve(env, opts.startupObserve, opts.observeArgs ?? {});
  notes.push(`observed ${snapshot.type} fingerprint=${snapshot.fingerprint.slice(0, 12)}`);
  pushTrace({ phase: "observe", detail: snapshot.type, duration_ms: Date.now() - observeStart, ok: true });

  // 3. FIND
  await reportProgress(opts, { phase: "find", detail: "Searching for a matching capability" });
  const findStart = Date.now();
  const candidates = await tools.find(opts.goal, { snapshot, limit: 3 });
  const top = candidates[0];
  notes.push(`find: ${candidates.length} candidate(s)` + (top ? ` top=${top.name} conf=${top.confidence.toFixed(2)}` : ""));
  pushTrace({
    phase: "find",
    name: top?.name,
    detail: `${candidates.length} candidate(s)`,
    duration_ms: Date.now() - findStart,
    ok: true,
  });

  // 4. GATE — choose escalation level.
  let level: EscalationLevel;
  // Why the top candidate is being repaired rather than run, when that's the case. Carried into
  // the reasoner as the repair target so a patch is aimed at the real error, not guessed at.
  let repairReason: string | undefined;
  // Tested on RELEVANCE, not confidence: the floor answers "is there a skill about this at all?",
  // which health has no business changing. Testing the health-adjusted number here would read a
  // broken-but-obviously-relevant skill as "nothing found" and send the agent off to write a
  // SECOND skill for a job it already has one for, instead of fixing the one it has.
  if (top && top.relevance >= cfg.confidenceFloor) {
    const fpSim = fingerprintSimilarity(snapshot, top.metadata.fingerprint_schema);
    // A skill that has been failing must never run unattended, however good its lifetime
    // record looks — that is exactly how a broken skill kept getting picked and kept failing.
    // It still runs, but with the model in the loop and its own recorded error in hand.
    const health = top.health ?? assessSkillHealth(top.metadata);
    if (!isSafeToAutoRun(health.state)) {
      repairReason = health.recommendation;
      level = top.metadata.patch_history.length < cfg.maxPatchesBeforeL3 ? "L2" : "L3";
    } else if (top.metadata.stability_score > cfg.stabilityFloorForL1 && isMatch(fpSim, cfg.fingerprintTolerance)) {
      level = "L1";
    } else if (isPartial(fpSim, cfg.fingerprintTolerance) && top.metadata.patch_history.length < cfg.maxPatchesBeforeL3) {
      level = "L2";
      repairReason = "fingerprint drift (partial match)";
    } else {
      level = "L3";
    }
  } else {
    level = "L4";
  }
  notes.push(`gate → ${level}` + (repairReason ? ` (repair: ${repairReason})` : ""));
  pushTrace({ phase: "gate", detail: level, ok: true });

  // 5-7. EXECUTE / VERIFY / DISTILL per level.
  switch (level) {
    case "L1": {
      const params = paramsFor(top!, opts.goal);
      // HITL gate before execution
      const gate = await hitlGate(top!.name, params, gatedActions, approvalMode, env.hitlGateway, runId, sessionId, notes, preApproved);
      if (gate.verdict === "pending") return suspend(level, gate, top!.name, params, opts.resumeSteps ?? []);
      if (gate.verdict === "denied") {
        return finish({ level, script_name: top!.name, result: { ok: false, error: gateRejectedMessage(top!.name), tier: 1 as const, duration_ms: 0, tokens_used: 0 }, notes });
      }
      await reportProgress(opts, { phase: "run", name: top!.name, detail: `Running ${top!.name}`, params });
      const result = await runOnce(top!.name, params);
      notes.push(`L1 run ${top!.name}: ${result.ok ? "ok" : "fail"}`);
      pushTrace({
        phase: "run", name: top!.name, tier: result.tier, duration_ms: result.duration_ms, tokens: result.tokens_used,
        ok: result.ok, detail: result.error, params, ...(result.commit_oid ? { commit_oid: result.commit_oid } : {}), ...(result.ok ? { output: formatToolOutput(result.output) } : {}),
      });
      return finish({ level, script_name: top!.name, result, notes });
    }

    case "L2": {
      // Cheap patch of a drifted script, then run the patched version.
      await reportProgress(opts, { phase: "reason", detail: "Thinking…" });
      const reasonStart = Date.now();
      const decision = await reasoner.decide({
        goal: opts.goal,
        level,
        snapshot,
        candidates,
        availableOperations: tools.availableOperations(),
          operationGroups: tools.disclosureGroups(),
        activeCatalog: await tools.activeCatalog(),
        ...(opts.conversation ? { conversation: opts.conversation } : {}),
        repairTarget: { name: top!.name, failureReason: repairReason ?? "fingerprint drift (partial match)" },
        ...(deltaReporter(opts) ? { onDelta: deltaReporter(opts)! } : {}),
      });
      const usage = usageOf(reasoner);
      pushTrace({
        phase: "reason",
        name: top?.name,
        detail: decision.action,
        tokens: usage.input + usage.output,
        duration_ms: Date.now() - reasonStart,
        ...(thinkingOf(reasoner) ? { thinking: thinkingOf(reasoner) } : {}),
        ...(narrationOf(reasoner) ? { narration: narrationOf(reasoner) } : {}),
        ...(messageOf(reasoner) ? { message: messageOf(reasoner) } : {}),
      });
      if (decision.action === "patch") {
        await tools.update(decision.name, { code: decision.code }, decision.reason);
        const params = paramsFor(top!, opts.goal);
        const gate = await hitlGate(decision.name, params, gatedActions, approvalMode, env.hitlGateway, runId, sessionId, notes, preApproved);
        if (gate.verdict === "pending") return suspend(level, gate, decision.name, params, opts.resumeSteps ?? []);
        if (gate.verdict === "denied") {
          return finish(withTokenUsage({ level, script_name: decision.name, result: { ok: false, error: gateRejectedMessage(decision.name), tier: 1 as const, duration_ms: 0, tokens_used: 0 }, notes }, usage));
        }
        await reportProgress(opts, { phase: "run", name: decision.name, detail: `Running ${decision.name}` });
        const result = await runOnce(decision.name, params);
        notes.push(`L2 patched ${decision.name}: ${result.ok ? "ok" : "fail"}`);
        pushTrace({ phase: "run", name: decision.name, tier: result.tier, duration_ms: result.duration_ms, tokens: result.tokens_used, ok: result.ok, detail: result.error, ...(result.commit_oid ? { commit_oid: result.commit_oid } : {}) });
        // Automatic rollback on immediate failure (spec §10.3).
        if (!result.ok) {
          const meta = await tools.skillLibrary.readMetadata(decision.name);
          if (meta && meta.version > 1) {
            await tools.skillLibrary.rollback(decision.name, meta.version - 1);
            notes.push(`L2 rollback ${decision.name} → v${meta.version - 1}`);
          }
        }
        return finish(withTokenUsage({ level, script_name: decision.name, result, distilled_script: decision.name, notes }, usage));
      }
      return finish(withTokenUsage(await applyTerminalDecision(level, decision, tools, opts.goal, notes, pushTrace, runOnce), usage));
    }

    case "L3":
    case "L4": {
      // Full re-derivation (L3) or live first-principles reasoning then distill (L4).
      //
      // This used to be `for (step = 0; step < (opts.maxSteps ?? 6); step++)`, and the interactive
      // chat path never overrode that six. It is now bounded by what is actually scarce — tokens,
      // wall clock, and progress — with a runaway ceiling far above real use (loop-budget.ts), and
      // the history is compacted each turn so a long run can't overflow the model's context
      // (step-context.ts). Those two together are what make "as many steps as the task needs"
      // possible rather than just permitted.
      const budget = resolveLoopBudget({
        ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
        ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
        ...(opts.deadlineAt !== undefined ? { deadlineAt: opts.deadlineAt } : {}),
        ...(opts.maxStallSteps !== undefined ? { maxStallSteps: opts.maxStallSteps } : {}),
      });
      let stepLimits = stepLimitsForModel(opts.contextWindowTokens ?? DEFAULT_ASSUMED_CONTEXT_WINDOW);
      /** Consecutive steps that produced no successful tool result — see LoopBudget.maxStallSteps. */
      let stallSteps = 0;
      /** Longest single step so far, so the deadline check knows whether another one fits. */
      let longestStepMs = 0;
      /** How many times a context-overflow error has forced a harder squeeze this run. */
      let overflowRetries = 0;
      /** Why the loop stopped taking steps, for the message the user eventually reads. */
      let exhaustionReason = "";
      let lastDecision: ReasonDecision | null = null;
      const usageAcc = { input: 0, output: 0 };
      // What this run has already done, fed back into every subsequent decide() call. Seeded from
      // a suspended pass's completed steps on resume, so an approval that arrives an hour later
      // continues the work rather than starting it over.
      const priorSteps: Array<{ name: string; params: Record<string, unknown>; ok: boolean; output?: unknown; error?: string }> = [
        ...(opts.resumeSteps ?? []),
      ];
      // Same array, exposed on every exit by finish() — so a run that fails can be continued
      // from what it had already done rather than restarted from nothing.
      stepsOut = priorSteps;
      // The run's plan (the `plan` prebuilt). Reconstructed from resumeSteps so a plan set before an
      // approval-suspend survives the resume; the plan ops mutate this SAME object by reference
      // (it's on env), and the terminal-decision gate below reads it. A fresh run starts empty.
      env.plan = reconstructPlanFromSteps(opts.resumeSteps ?? []);
      /** How many times in a row the plan gate has refused a premature stop — bounded so it can
       *  never itself drive the run to the runaway ceiling (see MAX_PLAN_GATE_REFUSALS). */
      let planGateRefusals = 0;
      // Actions parked mid-run because they need a human. The run continues around them; each one
      // carries its own checkpoint so it can be picked up alone when the answer arrives.
      const deferred: NonNullable<LoopResult["deferred_approvals"]> = [];
      deferredOut = deferred;
      // The most recent SUCCESSFUL tool result, kept so an agent that runs out of steps without
      // ever composing an answer still returns the work it actually did rather than "gave up".
      let lastGoodRun: { name: string; result: ScriptRunResult } | null = null;
      /** `name:params` → the REAL outcome of the first attempt this run — see the repeat guard
       *  below. Only ever set once the outcome is actually known (never for a merely "pending"
       *  gate, which never reaches here). */
      const attemptedCalls = new Map<string, { ok: boolean; output?: unknown; error?: string }>();
      for (let step = 0; ; step++) {
        // Stopped by a person. Not an error and not a failure: the steps already taken are real
        // and are reported, which is the difference between "I stopped, here is what I did" and a
        // run that simply vanishes.
        if (opts.shouldCancel && (await opts.shouldCancel())) {
          pushTrace({ phase: "give_up", ok: false, detail: "stopped by the user" });
          notes.push(`${level} stopped at the user's request after ${priorSteps.length} step(s)`);
          const done = priorSteps.filter((p) => p.ok).map((p) => p.name);
          // `ok: false` (not `ok: true`) is what makes this an interrupted run rather than a plain
          // completed answer — the caller (NaelaoAgentDO.handleScriptRun) only checkpoints an
          // offer to continue when `result.ok === false`, and that offer is the whole point of
          // stopping deliberately rather than losing the work outright. `error` carries the exact,
          // stable marker `packages/events`' classifyFailure matches on ("user_cancelled") — never
          // change this string without updating that pattern too. `output` still carries the
          // human-readable summary, which is written into the transcript exactly like any other
          // answer (NaelaoAgentDO checks for a non-empty `output`, not `ok`).
          return finish(withTokenUsage({
            level,
            result: {
              ok: false,
              output: done.length > 0
                ? `Stopped. I had already finished: ${done.join(", ")}.`
                : "Stopped before anything ran.",
              error: "Stopped by you before finishing.",
              tier: 1,
              duration_ms: 0,
              tokens_used: 0,
            },
            notes,
          }, usageAcc));
        }
        const assessment = assessBudget(budget, {
          step,
          tokensUsed: usageAcc.input + usageAcc.output,
          stallSteps,
          now: Date.now(),
          longestStepMs,
        });
        if (assessment.verdict === "exhausted") {
          exhaustionReason = assessment.reason;
          notes.push(`${level} stopped taking steps: ${assessment.reason}`);
          break;
        }
        // One turn left before some budget runs out, so the model is told to finish now. Without
        // this a model that keeps choosing `run` simply falls off the end and the user is told the
        // agent "never reached an answer" — even when the work itself succeeded. Reported live: a
        // project was created, the loop then burned its remaining steps and surfaced an error, so
        // the user retried and created a second one.
        const isFinalStep = assessment.verdict === "final";
        // Recorded even though the run may well answer normally from here: if it does NOT, this is
        // the only place that knows why it was down to its last turn, and "ran out of time" versus
        // "ran out of budget" versus "made no progress" are three different things for a reader.
        if (isFinalStep) exhaustionReason = assessment.reason;
        await reportProgress(opts, {
          phase: "reason",
          detail: isFinalStep ? "Wrapping up…" : `Thinking (step ${step + 1})…`,
        });
        const reasonStart = Date.now();
        // Fold the older half of this run's history into one line per step, so a long run stays
        // inside the model's real context window instead of overflowing it somewhere past step
        // twenty. The full `priorSteps` array is untouched — checkpoints and deferred approvals
        // need the real results.
        const stepContext = compactSteps(priorSteps, stepLimits);
        if (stepContext.compacted) {
          notes.push(`${level} folded ${stepContext.omitted} earlier step(s) to fit the context window`);
        }
        // Real-time progress, recomputed fresh every turn from what has actually happened so far —
        // see the field's own doc on Reasoner.decide for why this is passed on every step rather
        // than only the final one.
        const successfulActions = priorSteps.filter((p) => p.ok).length;
        const decision = await reasoner.decide({
          goal: opts.goal,
          level,
          snapshot,
          candidates,
          availableOperations: tools.availableOperations(),
          operationGroups: tools.disclosureGroups(),
        activeCatalog: await tools.activeCatalog(),
          ...(opts.conversation ? { conversation: opts.conversation } : {}),
          ...(level === "L3" && top
            ? { repairTarget: { name: top.name, failureReason: repairReason ?? "stale / re-derive" } }
            : {}),
          ...(stepContext.recent.length > 0 ? { priorSteps: stepContext.recent } : {}),
          ...(stepContext.digest.length > 0 ? { earlierSteps: stepContext.digest } : {}),
          ...(isFinalStep ? { finalStep: true } : {}),
          progress: {
            step: step + 1,
            max_steps: budget.maxSteps,
            successful_actions: successfulActions,
            failed_actions: priorSteps.length - successfulActions,
            stall_steps: stallSteps,
            max_stall_steps: budget.maxStallSteps,
            tokens_used: usageAcc.input + usageAcc.output,
            ...(budget.maxTokens !== undefined ? { max_tokens: budget.maxTokens } : {}),
          },
          // The committed plan, present only once the model has set one — so it always sees which
          // steps remain even after history is compacted, and knows it's held to finishing them.
          ...(env.plan && env.plan.steps.length > 0
            ? {
                plan: {
                  total: env.plan.steps.length,
                  completed: env.plan.steps.filter((s) => s.done).length,
                  remaining: env.plan.steps.filter((s) => !s.done).length,
                  steps: env.plan.steps.map((s) => ({ id: s.id, text: s.text, done: s.done })),
                },
              }
            : {}),
          ...(deltaReporter(opts) ? { onDelta: deltaReporter(opts)! } : {}),
        });
        longestStepMs = Math.max(longestStepMs, Date.now() - reasonStart);
        const stepUsage = usageOf(reasoner);
        usageAcc.input += stepUsage.input;
        usageAcc.output += stepUsage.output;

        // The model's context overflowed anyway — a candidate list, an observation snapshot or a
        // single enormous conversation can push a payload over even after the steps are compacted.
        // That has a real recovery (carry less and try again), unlike every other provider error,
        // so it is not allowed to end the run the way a give_up otherwise would.
        if (decision.action === "give_up" && isContextOverflowError(decision.reason) && overflowRetries < MAX_OVERFLOW_RETRIES) {
          overflowRetries++;
          stepLimits = squeezeStepLimits(stepLimits);
          notes.push(`${level} hit the model's context limit; carrying less history and retrying (attempt ${overflowRetries})`);
          pushTrace({ phase: "reason", detail: "context overflow → compacting harder", ok: false });
          continue;
        }
        // Normalize a script-qualified operation name BEFORE anything authorizes or records it —
        // the gate, the repeat guard and the action ledger all key on decision.name, so an alias
        // resolved any later would be a different action to every one of them. See
        // ScriptToolSurface.resolveOperationAlias for what it will and will not resolve.
        if (decision.action === "run") {
          const resolved = tools.resolveOperationAlias(decision.name, decision.params);
          decision.name = resolved.name;
          decision.params = resolved.params;
        }

        lastDecision = decision;
        pushTrace({
          phase: "reason",
          name: decision.action === "run" || decision.action === "patch" || decision.action === "distill" ? decision.name : undefined,
          detail: decision.action,
          tokens: stepUsage.input + stepUsage.output,
          duration_ms: Date.now() - reasonStart,
          ...(thinkingOf(reasoner) ? { thinking: thinkingOf(reasoner) } : {}),
          ...(narrationOf(reasoner) ? { narration: narrationOf(reasoner) } : {}),
        ...(messageOf(reasoner) ? { message: messageOf(reasoner) } : {}),
        });

        if (decision.action === "run") {
          // The model was told this is its last turn and chose a tool anyway. Running it would
          // spend real money/side effects on work nobody will ever see the result of, since
          // there's no step left to report it in — so it isn't run, and the loop drops straight
          // into the summary path below with whatever already succeeded.
          if (isFinalStep) {
            notes.push(`${level} chose ${decision.name} on the final step (${assessment.reason}); not run — summarising instead`);
            // Without this, the "reason" step just pushed above (carrying the model's own status
            // for THIS action, e.g. "Reading the report") is left as the segment's narration with
            // no row ever recorded for it — the closing-summary decide() call below doesn't push
            // its own trace step, so the segment closes on the eventual answer with a description
            // attached to nothing. This row is what keeps the two together.
            pushTrace({ phase: "gate", name: decision.name, detail: "skipped_final_step", params: decision.params });
            break;
          }

          // Now that a successful run no longer ends the loop, a model that ignores its own
          // observations could burn every remaining step re-running the identical call. Serving
          // the result it already has costs nothing, keeps the observation accurate, and bounds
          // the damage — while a call with DIFFERENT params is still allowed through, since
          // re-running an op with new arguments is ordinary work, not a pathology.
          const callKey = `${decision.name}:${stableStringify(decision.params)}`;

          // Checked BEFORE the repeat guard, deliberately. A parked action was added to
          // attemptedCalls but never actually ran, so the repeat guard would answer "already run
          // in this task" — telling the model a gated action succeeded when it is still sitting
          // unapproved. That is the worst possible thing to be wrong about here.
          if (deferred.some((d) => d.action_name === decision.name)) {
            // A live-reported bug: the "reason" step just pushed above (its own narration/doing
            // text, e.g. "Checking on that payout") had nothing recorded under it when the model
            // re-asked about an action still parked pending approval — this branch `continue`d
            // with no trace push at all, so the UI showed a status line with no table row beneath
            // it. Same `detail` the FIRST park uses, so it renders identically ("waiting for
            // approval") rather than needing a second label the client has to know about.
            pushTrace({ phase: "gate", name: decision.name, detail: "deferred_pending_approval", params: decision.params });
            priorSteps.push({
              name: decision.name,
              params: decision.params,
              ok: false,
              error: "still waiting on a human for this one — do something else, or answer with what you have",
            });
            stallSteps++;
            continue;
          }

          // A live-reported bug: this used to record `callKey` as "attempted" BEFORE knowing the
          // outcome, and the repeat guard below unconditionally told the model the repeat call
          // "already ran" with `ok: true` — even when the FIRST attempt had genuinely FAILED. A
          // model that (reasonably) retries a failed tool call would be told its retry succeeded
          // without either attempt ever actually running, so a real failure (a tool error, a
          // network problem, anything) got silently reported to the person as success. Fixed by
          // only recording an entry once the real outcome is known (gate-denied or run-completed
          // — never on "pending", which the `deferred.some()` check above already covers), and
          // having the repeat guard replay that REAL ok/output/error instead of assuming success.
          const attempted = attemptedCalls.get(callKey);
          if (attempted) {
            notes.push(`${level} skipped repeat call ${decision.name} (already ${attempted.ok ? "ran" : "failed"} this task)`);
            // Same live-reported gap as the deferred branch above: this used to `continue` with
            // no trace push, leaving the "reason" step's own narration ("Checking Instagram
            // tools…") rendered with no tool-call table beneath it — every REPEAT of an already-
            // attempted call was invisible in the UI even though a new reasoning turn (and its own
            // narration line) was genuinely spent on it. duration_ms: 0 and no tokens, since
            // nothing actually ran — this is the cached outcome, not a new attempt.
            pushTrace({
              phase: "run", name: decision.name, ok: attempted.ok, duration_ms: 0, params: decision.params,
              detail: attempted.ok ? "repeated — served the earlier result" : "repeated — already failed this task",
              ...(attempted.ok && attempted.output !== undefined ? { output: formatToolOutput(attempted.output) } : {}),
            });
            priorSteps.push({
              name: decision.name,
              params: decision.params,
              ok: attempted.ok,
              ...(attempted.ok
                ? { output: attempted.output ?? "(already run in this task — see the earlier step's result)" }
                : {
                    error:
                      attempted.error ??
                      "(already failed in this task with the same arguments — retrying will not help; try something different or answer describing the failure)",
                  }),
            });
            // Re-issuing a call it has already made is the single clearest sign a model is going
            // in circles. It costs a real reasoning turn and produces nothing new, so it counts
            // against the stall budget however the original attempt went.
            stallSteps++;
            continue;
          }

          // HITL gate before execution
          const gate = await hitlGate(decision.name, decision.params, gatedActions, approvalMode, env.hitlGateway, runId, sessionId, notes, preApproved);
          if (gate.verdict === "pending") {
            // Park it and CARRY ON. Blocking the whole run here is what made an agent useless the
            // moment it needed permission for one thing: an assistant with five jobs to do would
            // stop dead on the first one that needed a signature, and stay stopped until someone
            // happened to look. Nothing gated has run, so the rest of the task is still safe to
            // work on — and the parked action resumes on its own once someone answers.
            deferred.push({
              approval_id: gate.approvalId,
              action_name: decision.name,
              params: decision.params,
              ...(gate.expiresAt ? { expires_at: gate.expiresAt } : {}),
              steps_completed: [...priorSteps],
            });
            notes.push(`${level} parked '${decision.name}' pending approval and continued`);
            pushTrace({ phase: "gate", name: decision.name, detail: "deferred_pending_approval", params: decision.params });
            priorSteps.push({
              name: decision.name,
              params: decision.params,
              ok: false,
              error:
                "waiting on a human to approve this — it has NOT run. Continue with anything else " +
                "the task needs that doesn't depend on it, then answer describing what you did and " +
                "what is still waiting. Do not retry this call.",
            });
            stallSteps++;
            continue;
          }
          if (gate.verdict === "denied") {
            return finish(withTokenUsage({ level, script_name: decision.name, result: { ok: false, error: gateRejectedMessage(decision.name), tier: 1 as const, duration_ms: 0, tokens_used: 0 }, notes }, usageAcc));
          }
          await reportProgress(opts, { phase: "run", name: decision.name, detail: `Running ${decision.name}`, params: decision.params });
          const result = await runOnce(decision.name, decision.params);
          // A slow tool eats the wall clock exactly as a slow model does, so the deadline margin
          // has to be measured over the whole turn, not just the reasoning half of it.
          longestStepMs = Math.max(longestStepMs, Date.now() - reasonStart);
          // Progress is a tool call that actually worked. Anything else — a failure, a repeat, an
          // action parked for a human — leaves the run no closer to done than it was, and enough
          // of those in a row is the signal to stop and report rather than keep paying.
          stallSteps = result.ok ? 0 : stallSteps + 1;
          notes.push(`${level} run ${decision.name}: ${result.ok ? "ok" : "fail"}`);
          pushTrace({
            phase: "run", name: decision.name, tier: result.tier, duration_ms: result.duration_ms, tokens: result.tokens_used,
            ok: result.ok, detail: result.error, params: decision.params,
            ...(result.commit_oid ? { commit_oid: result.commit_oid } : {}),
            ...(result.ok ? { output: formatToolOutput(result.output) } : {}),
          });
          // The real outcome, recorded for the repeat guard above — see its own comment for why
          // this must never be assumed to be a success.
          attemptedCalls.set(callKey, {
            ok: result.ok,
            ...(result.output !== undefined ? { output: result.output } : {}),
            ...(result.error !== undefined ? { error: result.error } : {}),
          });
          // Record what happened and KEEP GOING. This used to `return` on the first successful
          // tool call, handing the tool's raw result back as the run's answer — so the model never
          // observed its own output, could never chain two calls, and a user asking "look up the
          // order, then follow the refund policy" got whatever the lookup happened to return
          // (frequently an empty string). Only `answer`/`give_up` end a run now; a tool call is a
          // step within it, which is what the OBSERVE→…→VERIFY loop always described.
          priorSteps.push({
            name: decision.name,
            params: decision.params,
            ok: result.ok,
            ...(result.ok ? { output: result.output } : { error: result.error ?? "failed" }),
          });
          if (result.ok) lastGoodRun = { name: decision.name, result };
          continue;
        }

        if (decision.action === "distill" || decision.action === "patch") {
          return finish(withTokenUsage(await applyTerminalDecision(level, decision, tools, opts.goal, notes, pushTrace, runOnce), usageAcc));
        }

        if (decision.action === "answer" || decision.action === "give_up") {
          // Plan gate — the "don't stop half-done" enforcement. Once the agent has committed to a
          // plan (the `plan` prebuilt), it may not answer or give up while any step is still open:
          // that is the single most common way multi-step autonomous work goes half-finished. The
          // model is told to finish the remaining work and mark each step done (plan.complete_step)
          // — or, if a step is genuinely impossible, to do what it can and say so plainly in the
          // answer. The escapes the user explicitly allows are respected: it is NOT applied on the
          // final step (budget/time is out — that is the "error/resource" stop the user permits, and
          // re-gating it would leave the run no way to ever end), and a user Stop / a real error take
          // their own exits entirely. Bounded by MAX_PLAN_GATE_REFUSALS AND the stall budget so it
          // can never itself drive a run to the runaway ceiling.
          const openSteps = env.plan?.steps.filter((s) => !s.done) ?? [];
          if (openSteps.length > 0 && !isFinalStep && planGateRefusals < MAX_PLAN_GATE_REFUSALS) {
            planGateRefusals++;
            const remaining = openSteps.map((s) => `${s.id}: ${s.text}`).join("; ");
            notes.push(`${level} tried to ${decision.action} with ${openSteps.length} plan step(s) still open — refused (${planGateRefusals}/${MAX_PLAN_GATE_REFUSALS})`);
            pushTrace({ phase: "gate", detail: "plan_incomplete", ok: false });
            priorSteps.push({
              name: "(plan not finished)",
              params: {},
              ok: false,
              error:
                `You tried to ${decision.action}, but your own plan still has ${openSteps.length} ` +
                `step(s) not marked done: ${remaining}. You committed to this plan and must not stop ` +
                `until it is finished. Do the work for the next open step, then mark it done with ` +
                `plan.complete_step. If a step is genuinely impossible, finish every step you CAN, ` +
                `then in your answer say plainly which step you couldn't do and why. Do not repeat ` +
                `this answer/give_up until every step is done or explicitly resolved.`,
            });
            stallSteps++;
            continue;
          }
          return finish(withTokenUsage(await applyTerminalDecision(level, decision, tools, opts.goal, notes, pushTrace, runOnce), usageAcc));
        }

        // An action this loop cannot act on. Previously this just fell off the end of the body and
        // silently took another turn — a wasted step with no error anywhere, and the model got no
        // signal that its reply was unusable, so it would produce the same thing again. Now it is
        // told, and it counts against the stall budget like any other non-progress.
        notes.push(`${level} ignored an unusable decision: ${JSON.stringify((decision as { action?: unknown }).action)}`);
        pushTrace({ phase: "reason", detail: "unusable decision", ok: false });
        priorSteps.push({
          name: "(invalid decision)",
          params: {},
          ok: false,
          error:
            "your last reply was not one of the five allowed actions. Reply with exactly one of " +
            "run / distill / patch / answer / give_up, and nothing else.",
        });
        stallSteps++;
      }
      // Ran out of budget without ever composing an answer.
      //
      // A raw tool payload is still never returned as "the answer" — there is no reliable way to
      // tell a receipt (`{written: true}`) from a result worth reading (`{content: "..."}`), and
      // guessing wrong hands the user `ok` plus a blank or a JSON dump.
      //
      // But failing outright was ALSO wrong, and was reported live: a project really was created,
      // the loop then burned its remaining steps, and the user was shown
      // "Ran 6 step(s) without reaching an answer" with a Try again button — so they retried and
      // created a second project. Successful work reported as a failure is worse than no report.
      //
      // So: ask the model for the summary it failed to write, restricted to a terminal decision.
      // That is not guessing at a payload — it is the same model, with the same observations,
      // asked only to say what happened. If it still won't answer, the honest error stands.
      //
      // The condition is "did anything happen at all", NOT "did a tool succeed". Caught on a live
      // production run: an agent whose only tool was gated parked one approval, spent its stall
      // budget re-picking the same parked action, and — because no run had ever SUCCEEDED — skipped
      // this block entirely and returned "no terminal action". The user saw a dead-end failure when
      // the truth was "I need you to approve list_files", which is both actionable and true.
      if (priorSteps.length > 0) {
        const ran = priorSteps.filter((p) => p.ok).map((p) => p.name).join(", ");
        notes.push(`${level} ran ${priorSteps.length} step(s) but never composed an answer`);
        try {
          const closing = compactSteps(priorSteps, stepLimits);
          const summary = await reasoner.decide({
            goal: opts.goal,
            level,
            snapshot,
            candidates,
            availableOperations: tools.availableOperations(),
          operationGroups: tools.disclosureGroups(),
        activeCatalog: await tools.activeCatalog(),
            ...(opts.conversation ? { conversation: opts.conversation } : {}),
            priorSteps: closing.recent,
            ...(closing.digest.length > 0 ? { earlierSteps: closing.digest } : {}),
            finalStep: true,
            ...(deltaReporter(opts) ? { onDelta: deltaReporter(opts)! } : {}),
          });
          const summaryUsage = usageOf(reasoner);
          usageAcc.input += summaryUsage.input;
          usageAcc.output += summaryUsage.output;
          if (summary.action === "answer" || summary.action === "give_up") {
            notes.push(`${level} composed a closing summary after exhausting its steps`);
            return finish(withTokenUsage(
              await applyTerminalDecision(level, summary, tools, opts.goal, notes, pushTrace, runOnce),
              usageAcc
            ));
          }
          notes.push(`${level} summary attempt returned ${summary.action}; reporting the exhaustion instead`);
        } catch (err) {
          // Never let the recovery attempt itself become the failure the user sees.
          notes.push(`${level} summary attempt failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        // Waiting on a human is the single most actionable thing this message can say, so it leads.
        // Without it the reader is told the agent failed, when what actually happened is that it is
        // blocked on them.
        const waiting = deferred.map((d) => d.action_name).join(", ");
        return finish(withTokenUsage({
          level,
          ...(lastGoodRun ? { script_name: lastGoodRun.name } : {}),
          result: {
            ok: false,
            // Names WHY it stopped, not just that it did. "Ran 6 steps without reaching an answer"
            // told a user nothing they could act on; "ran out of time" and "made no progress for
            // several steps" are different problems with different responses.
            error:
              (waiting ? `Waiting on your approval for: ${waiting}. ` : "") +
              `Ran ${priorSteps.length} step(s) without reaching an answer` +
              (exhaustionReason ? ` — ${exhaustionReason}` : "") +
              ` (completed: ${ran || "none"})`,
            tier: 1 as const,
            duration_ms: 0,
            tokens_used: 0,
          },
          notes,
        }, usageAcc));
      }
      return finish(withTokenUsage(
        await applyTerminalDecision(level, lastDecision ?? { action: "give_up", reason: "no decision" }, tools, opts.goal, notes, pushTrace, runOnce),
        usageAcc
      ));
    }
  }
}

/** Key-order-independent JSON, so {a:1,b:2} and {b:2,a:1} are recognized as the same call —
 *  a model re-emitting identical arguments in a different order is still a repeat. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** Reads the reasoner's most recently reported usage; zeros when unreported. */
function usageOf(reasoner: Reasoner): { input: number; output: number } {
  const u = reasoner.lastUsage;
  return u ? { input: u.input_tokens, output: u.output_tokens } : { input: 0, output: 0 };
}

/** Reads the reasoner's most recently reported chain-of-thought, when it reported one. */
function thinkingOf(reasoner: Reasoner): string | undefined {
  return reasoner.lastThinking;
}

/** Reads the reasoner's most recent live status line for the action it just chose. */
function narrationOf(reasoner: Reasoner): string | undefined {
  return reasoner.lastNarration;
}

/** Reads the real message the reasoner chose to write to the person, on the turns it wrote one. */
function messageOf(reasoner: Reasoner): string | undefined {
  return reasoner.lastMessage;
}

/**
 * Adds real reasoner token spend onto a LoopResult's result, if it carries one. Keeps the
 * input/output breakdown (not just the combined total) so the host can price it per-model —
 * input and output tokens are billed at different rates (spec §15 / billing-core pricing).
 */
function withTokenUsage(loopResult: LoopResultCore, usage: { input: number; output: number }): LoopResultCore {
  const total = usage.input + usage.output;
  if (!loopResult.result || total === 0) return loopResult;
  return {
    ...loopResult,
    result: {
      ...loopResult.result,
      tokens_used: loopResult.result.tokens_used + total,
      input_tokens: (loopResult.result.input_tokens ?? 0) + usage.input,
      output_tokens: (loopResult.result.output_tokens ?? 0) + usage.output,
    },
  };
}

/** Best-effort parameter resolution for a matched script (host can override via reasoner). */
function paramsFor(_candidate: FindCandidate, _goal: string): Record<string, unknown> {
  // For L1 the script is parameterized; a richer host maps goal → params via the reasoner.
  // The minimal driver passes through no params and relies on script defaults.
  return {};
}

/** Persist a distilled/patched script (DISTILL) or surface an answer / give-up. */
async function applyTerminalDecision(
  level: EscalationLevel,
  decision: ReasonDecision,
  tools: ScriptToolSurface,
  goal: string,
  notes: string[],
  pushTrace: PushTrace,
  /** Ledger-guarded execution. Distill and patch both AUTHOR a script and then run it, and that
   *  run has real side effects — on a replay it would be re-derived and re-run, so it needs the
   *  same exactly-once treatment as any other action. Defaults to a plain run for callers (tests)
   *  that don't wire a ledger. */
  runAction: (name: string, params: Record<string, unknown>) => Promise<ScriptRunResult> = (n, p) => tools.run(n, p)
): Promise<LoopResultCore> {
  if (decision.action === "distill") {
    // DISTILL (spec §7): compile the successful trace into a reusable parameterized script.
    const exists = await tools.skillLibrary.exists(decision.name);
    if (exists) {
      await tools.update(decision.name, { code: decision.code, metadata: decision.metadata }, "distilled refinement");
    } else {
      await tools.create({
        name: decision.name,
        code: decision.code,
        metadata: {
          description: (decision.metadata.description as string) ?? goal,
          domain: decision.metadata.domain ?? "compute",
          requires_tier: decision.metadata.requires_tier ?? 2,
          ...decision.metadata,
          origin: "distilled",
        } as ScriptMetadata,
      });
    }
    const result = await runAction(decision.name, decision.params);
    notes.push(`${level} distilled ${decision.name}: ${result.ok ? "ok" : "fail"}`);
    pushTrace({ phase: "run", name: decision.name, tier: result.tier, duration_ms: result.duration_ms, tokens: result.tokens_used, ok: result.ok, detail: `distilled: ${result.error ?? "ok"}`, ...(result.commit_oid ? { commit_oid: result.commit_oid } : {}) });
    return { level, script_name: decision.name, result, distilled_script: decision.name, notes };
  }

  if (decision.action === "patch") {
    await tools.update(decision.name, { code: decision.code }, decision.reason);
    const result = await runAction(decision.name, {});
    notes.push(`${level} patched ${decision.name}`);
    pushTrace({ phase: "run", name: decision.name, tier: result.tier, duration_ms: result.duration_ms, tokens: result.tokens_used, ok: result.ok, detail: `patched: ${result.error ?? "ok"}`, ...(result.commit_oid ? { commit_oid: result.commit_oid } : {}) });
    return { level, script_name: decision.name, result, distilled_script: decision.name, notes };
  }

  if (decision.action === "answer") {
    notes.push(`${level} answered directly`);
    pushTrace({ phase: "answer", ok: true, detail: "Composed a final answer" });
    return {
      level,
      result: { ok: true, output: decision.text, tier: 1, duration_ms: 0, tokens_used: 0 },
      notes,
    };
  }

  notes.push(`${level} gave up: ${decision.action === "give_up" ? decision.reason : "unknown"}`);
  pushTrace({ phase: "give_up", ok: false, detail: decision.action === "give_up" ? decision.reason : "no terminal action" });
  return {
    level,
    result: {
      ok: false,
      error: decision.action === "give_up" ? decision.reason : "no terminal action",
      tier: 1,
      duration_ms: 0,
      tokens_used: 0,
      // The model chose to stop and these are its own words — see ScriptRunResult.failure_origin
      // for why that must never be pattern-matched as an infrastructure failure. "no terminal
      // action" is the loop's own wording, so it stays classifiable as usual.
      ...(decision.action === "give_up" && decision.origin === "model"
        ? { failure_origin: "model" as const }
        : {}),
    },
    notes,
  };
}
