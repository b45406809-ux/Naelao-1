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
  ScriptRunResult,
} from "./types.js";

/** LoopResult before the shared trace array is attached — see `finish()` in runScriptLoop. */
type LoopResultCore = Omit<LoopResult, "trace">;

/** Records one structured trace step. Bound to a specific run's `trace` array by closure. */
type PushTrace = (step: Omit<TraceStep, "seq" | "ts">) => void;
import { ScriptToolSurface } from "./tool-surface.js";
import { runObserve } from "./observe.js";
import { fingerprintSimilarity, isMatch, isPartial } from "./fingerprint.js";
import { FIND_CONFIDENCE_FLOOR } from "./script-find.js";

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
  | { action: "give_up"; reason: string };

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
     * The thread's own conversation so far, bounded and possibly compacted.
     *
     * Without it the agent has no memory of the thread it is replying in: it cannot resolve
     * "do that again", cannot answer "what did we decide", and re-asks things the user already
     * told it. When `compacted` is set the model is told so explicitly and pointed at
     * conversation.search, rather than being left to answer confidently from a partial record.
     */
    conversation?: ConversationContext;
  }): Promise<ReasonDecision>;
  /** Token usage from the most recently completed decide() call, when the backing LLM
   *  client reports it. Optional — reasoners that can't report it (e.g. test fakes) leave
   *  this undefined, which the loop treats as zero, not an error. */
  lastUsage?: ReasonerUsage | undefined;
  /** The model's own chain-of-thought from the most recently completed decide() call, when the
   *  model/provider returned one (a reasoning-capable model with a reasoning level chosen — see
   *  billing-core's MODEL_CAPABILITIES). Optional — most reasoners/models never set this. */
  lastThinking?: string | undefined;
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

export interface RunLoopOptions {
  goal: string;
  startupObserve: string;
  observeArgs?: Record<string, unknown>;
  escalation?: Partial<EscalationConfig>;
  /** Cap on EXECUTE attempts within one pass (prevents runaway). */
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
  onProgress?: (checkpoint: Omit<TraceStep, "seq" | "ts">) => void | Promise<void>;
}

async function reportProgress(opts: RunLoopOptions, checkpoint: Omit<TraceStep, "seq" | "ts">): Promise<void> {
  if (!opts.onProgress) return;
  try {
    await opts.onProgress(checkpoint);
  } catch {
    /* progress reporting is a convenience, never fails the run */
  }
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
    const ledger = env.actionLedger;
    if (!ledger) return tools.run(name, params);
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
    const result = await tools.run(name, params);
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
  /** Parked-for-approval actions accumulated by the L3/L4 block, attached by finish() to whichever
   *  exit the run takes — so a run that answered around a parked action still reports it, rather
   *  than the outstanding work quietly disappearing with the reply. */
  let deferredOut: NonNullable<LoopResult["deferred_approvals"]> = [];
  const finish = (r: LoopResultCore): LoopResult => ({
    ...r,
    trace,
    ...(deferredOut.length > 0 ? { deferred_approvals: deferredOut } : {}),
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
    pushTrace({ phase: "gate", name: actionName, detail: "awaiting_approval" });
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
  if (top && top.confidence >= cfg.confidenceFloor) {
    const fpSim = fingerprintSimilarity(snapshot, top.metadata.fingerprint_schema);
    if (top.metadata.stability_score > cfg.stabilityFloorForL1 && isMatch(fpSim, cfg.fingerprintTolerance)) {
      level = "L1";
    } else if (isPartial(fpSim, cfg.fingerprintTolerance) && top.metadata.patch_history.length < cfg.maxPatchesBeforeL3) {
      level = "L2";
    } else {
      level = "L3";
    }
  } else {
    level = "L4";
  }
  notes.push(`gate → ${level}`);
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
      await reportProgress(opts, { phase: "run", name: top!.name, detail: `Running ${top!.name}` });
      const result = await runOnce(top!.name, params);
      notes.push(`L1 run ${top!.name}: ${result.ok ? "ok" : "fail"}`);
      pushTrace({ phase: "run", name: top!.name, tier: result.tier, duration_ms: result.duration_ms, tokens: result.tokens_used, ok: result.ok, detail: result.error });
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
        ...(opts.conversation ? { conversation: opts.conversation } : {}),
        repairTarget: { name: top!.name, failureReason: "fingerprint drift (partial match)" },
      });
      const usage = usageOf(reasoner);
      pushTrace({
        phase: "reason",
        name: top?.name,
        detail: decision.action,
        tokens: usage.input + usage.output,
        duration_ms: Date.now() - reasonStart,
        ...(thinkingOf(reasoner) ? { thinking: thinkingOf(reasoner) } : {}),
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
        pushTrace({ phase: "run", name: decision.name, tier: result.tier, duration_ms: result.duration_ms, tokens: result.tokens_used, ok: result.ok, detail: result.error });
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
      const maxSteps = opts.maxSteps ?? 6;
      let lastDecision: ReasonDecision | null = null;
      const usageAcc = { input: 0, output: 0 };
      // What this run has already done, fed back into every subsequent decide() call. Seeded from
      // a suspended pass's completed steps on resume, so an approval that arrives an hour later
      // continues the work rather than starting it over.
      const priorSteps: Array<{ name: string; params: Record<string, unknown>; ok: boolean; output?: unknown; error?: string }> = [
        ...(opts.resumeSteps ?? []),
      ];
      // Actions parked mid-run because they need a human. The run continues around them; each one
      // carries its own checkpoint so it can be picked up alone when the answer arrives.
      const deferred: NonNullable<LoopResult["deferred_approvals"]> = [];
      deferredOut = deferred;
      // The most recent SUCCESSFUL tool result, kept so an agent that runs out of steps without
      // ever composing an answer still returns the work it actually did rather than "gave up".
      let lastGoodRun: { name: string; result: ScriptRunResult } | null = null;
      /** `name:params` of every call already attempted this run — see the repeat guard below. */
      const attemptedCalls = new Set<string>();
      for (let step = 0; step < maxSteps; step++) {
        // Real per-token budget ceiling (sub-agent budgets — spec: enforce actual reasoner
        // spend, not a step-count proxy). Never starts a step it can't afford.
        if (opts.maxTokens && usageAcc.input + usageAcc.output >= opts.maxTokens) {
          notes.push(`${level} token budget ${opts.maxTokens} reached before step ${step + 1}`);
          break;
        }
        await reportProgress(opts, { phase: "reason", detail: `Thinking (step ${step + 1}/${maxSteps})…` });
        const reasonStart = Date.now();
        const decision = await reasoner.decide({
          goal: opts.goal,
          level,
          snapshot,
          candidates,
          availableOperations: tools.availableOperations(),
          ...(opts.conversation ? { conversation: opts.conversation } : {}),
          ...(level === "L3" && top
            ? { repairTarget: { name: top.name, failureReason: "stale / re-derive" } }
            : {}),
          ...(priorSteps.length > 0 ? { priorSteps } : {}),
        });
        const stepUsage = usageOf(reasoner);
        usageAcc.input += stepUsage.input;
        usageAcc.output += stepUsage.output;
        lastDecision = decision;
        pushTrace({
          phase: "reason",
          name: decision.action === "run" || decision.action === "patch" || decision.action === "distill" ? decision.name : undefined,
          detail: decision.action,
          tokens: stepUsage.input + stepUsage.output,
          duration_ms: Date.now() - reasonStart,
          ...(thinkingOf(reasoner) ? { thinking: thinkingOf(reasoner) } : {}),
        });

        if (decision.action === "run") {
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
            priorSteps.push({
              name: decision.name,
              params: decision.params,
              ok: false,
              error: "still waiting on a human for this one — do something else, or answer with what you have",
            });
            continue;
          }

          if (attemptedCalls.has(callKey)) {
            notes.push(`${level} skipped repeat call ${decision.name} (already run this task)`);
            priorSteps.push({
              name: decision.name,
              params: decision.params,
              ok: true,
              output: "(already run in this task — see the earlier step's result)",
            });
            continue;
          }
          attemptedCalls.add(callKey);

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
            pushTrace({ phase: "gate", name: decision.name, detail: "deferred_pending_approval" });
            priorSteps.push({
              name: decision.name,
              params: decision.params,
              ok: false,
              error:
                "waiting on a human to approve this — it has NOT run. Continue with anything else " +
                "the task needs that doesn't depend on it, then answer describing what you did and " +
                "what is still waiting. Do not retry this call.",
            });
            continue;
          }
          if (gate.verdict === "denied") {
            return finish(withTokenUsage({ level, script_name: decision.name, result: { ok: false, error: gateRejectedMessage(decision.name), tier: 1 as const, duration_ms: 0, tokens_used: 0 }, notes }, usageAcc));
          }
          await reportProgress(opts, { phase: "run", name: decision.name, detail: `Running ${decision.name}` });
          const result = await runOnce(decision.name, decision.params);
          notes.push(`${level} run ${decision.name}: ${result.ok ? "ok" : "fail"}`);
          pushTrace({ phase: "run", name: decision.name, tier: result.tier, duration_ms: result.duration_ms, tokens: result.tokens_used, ok: result.ok, detail: result.error });
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
          return finish(withTokenUsage(await applyTerminalDecision(level, decision, tools, opts.goal, notes, pushTrace, runOnce), usageAcc));
        }
      }
      notes.push(`${level} exhausted ${maxSteps} steps`);
      // Ran out of steps without ever composing an answer.
      //
      // This FAILS, always — even when tool calls succeeded along the way. Returning a raw tool
      // payload as "the answer" is the exact conflation this change set exists to fix: there is
      // no reliable way to tell a receipt (`{written: true}`) from a result worth reading
      // (`{content: "..."}`), and guessing wrong means the user gets `ok` plus a blank or a JSON
      // dump. The work that DID succeed is named in the error rather than discarded, so nothing
      // is hidden — but "the agent never answered you" is reported as what it is.
      if (lastGoodRun) {
        const ran = priorSteps.filter((p) => p.ok).map((p) => p.name).join(", ");
        notes.push(`${level} ran ${priorSteps.length} step(s) but never composed an answer`);
        return finish(withTokenUsage({
          level,
          script_name: lastGoodRun.name,
          result: {
            ok: false,
            error: `Ran ${priorSteps.length} step(s) without reaching an answer (completed: ${ran || "none"})`,
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
    pushTrace({ phase: "run", name: decision.name, tier: result.tier, duration_ms: result.duration_ms, tokens: result.tokens_used, ok: result.ok, detail: `distilled: ${result.error ?? "ok"}` });
    return { level, script_name: decision.name, result, distilled_script: decision.name, notes };
  }

  if (decision.action === "patch") {
    await tools.update(decision.name, { code: decision.code }, decision.reason);
    const result = await runAction(decision.name, {});
    notes.push(`${level} patched ${decision.name}`);
    pushTrace({ phase: "run", name: decision.name, tier: result.tier, duration_ms: result.duration_ms, tokens: result.tokens_used, ok: result.ok, detail: `patched: ${result.error ?? "ok"}` });
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
    },
    notes,
  };
}
