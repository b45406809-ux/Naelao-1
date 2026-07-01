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

import type {
  ScriptEngineEnv,
  ObserveSnapshot,
  LoopResult,
  FindCandidate,
  ScriptMetadata,
  EscalationLevel,
  HITLGateway,
} from "./types.js";
import { ScriptToolSurface } from "./tool-surface.js";
import { runObserve } from "./observe.js";
import { fingerprintSimilarity, isMatch, isPartial } from "./fingerprint.js";
import { FIND_CONFIDENCE_FLOOR } from "./script-find.js";

/**
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
 * Gate an action against the HITL policy. Returns true if execution should proceed.
 * When hitlGateway is absent or the action is not gated, always returns true (proceed).
 */
async function hitlGate(
  actionName: string,
  actionInput: Record<string, unknown>,
  gatedActions: Set<string>,
  gateway: HITLGateway | undefined,
  runId: string,
  sessionId: string,
  notes: string[]
): Promise<boolean> {
  if (!gatedActions.has(actionName) || !gateway) return true;
  notes.push(`HITL gate: requesting approval for '${actionName}'`);
  const { approved, reason, approvalId } = await gateway.requestApproval({
    runId,
    sessionId,
    actionName,
    actionInput,
    description: `The agent wants to run '${actionName}'. Review the parameters and approve or reject.`,
  });
  if (approved) {
    notes.push(`HITL ${approvalId}: approved → proceeding`);
    return true;
  }
  notes.push(`HITL ${approvalId}: rejected (${reason ?? "no reason"}) → aborting action`);
  return false;
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
  }): Promise<ReasonDecision>;
  /** Token usage from the most recently completed decide() call, when the backing LLM
   *  client reports it. Optional — reasoners that can't report it (e.g. test fakes) leave
   *  this undefined, which the loop treats as zero, not an error. */
  lastUsage?: ReasonerUsage | undefined;
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
   * Action names that require human approval before execution (from agents.md
   * `requires_approval_for:` block — parsed by NaelaoAgentDO and passed here).
   * When env.hitlGateway is present and the chosen action name is in this set,
   * the loop pauses and waits for HITLApprovalDO to resolve it before running.
   */
  requiresApprovalFor?: string[];
  /** Opaque run/session identifiers forwarded to the HITL gateway. */
  runId?: string;
  sessionId?: string;
  /**
   * Optional checkpoint callback (spec: incremental sub-agent progress — a parent shouldn't
   * have to wait for a whole child run to finish to see it's alive and making progress).
   * Called at OBSERVE, GATE (once the escalation level is known), and before each L3/L4
   * reasoning step. Never awaited into the critical path failing the run — a throwing
   * onProgress is swallowed, not propagated.
   */
  onProgress?: (checkpoint: { phase: string; detail?: string }) => void | Promise<void>;
}

async function reportProgress(opts: RunLoopOptions, phase: string, detail?: string): Promise<void> {
  if (!opts.onProgress) return;
  try {
    await opts.onProgress({ phase, ...(detail ? { detail } : {}) });
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
  const runId = opts.runId ?? crypto.randomUUID();
  const sessionId = opts.sessionId ?? "unknown";

  // 1-2. OBSERVE + FINGERPRINT
  const snapshot = await runObserve(env, opts.startupObserve, opts.observeArgs ?? {});
  notes.push(`observed ${snapshot.type} fingerprint=${snapshot.fingerprint.slice(0, 12)}`);
  await reportProgress(opts, "observe", snapshot.type);

  // 3. FIND
  const candidates = await tools.find(opts.goal, { snapshot, limit: 3 });
  const top = candidates[0];
  notes.push(`find: ${candidates.length} candidate(s)` + (top ? ` top=${top.name} conf=${top.confidence.toFixed(2)}` : ""));

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
  await reportProgress(opts, "gate", level);

  // 5-7. EXECUTE / VERIFY / DISTILL per level.
  switch (level) {
    case "L1": {
      const params = paramsFor(top!, opts.goal);
      // HITL gate before execution
      const allowed = await hitlGate(top!.name, params, gatedActions, env.hitlGateway, runId, sessionId, notes);
      if (!allowed) {
        return { level, script_name: top!.name, result: { ok: false, error: "HITL rejected", tier: 1 as const, duration_ms: 0, tokens_used: 0 }, notes };
      }
      const result = await tools.run(top!.name, params);
      notes.push(`L1 run ${top!.name}: ${result.ok ? "ok" : "fail"}`);
      return { level, script_name: top!.name, result, notes };
    }

    case "L2": {
      // Cheap patch of a drifted script, then run the patched version.
      const decision = await reasoner.decide({
        goal: opts.goal,
        level,
        snapshot,
        candidates,
        availableOperations: tools.availableOperations(),
        repairTarget: { name: top!.name, failureReason: "fingerprint drift (partial match)" },
      });
      const usage = usageOf(reasoner);
      if (decision.action === "patch") {
        await tools.update(decision.name, { code: decision.code }, decision.reason);
        const params = paramsFor(top!, opts.goal);
        const allowed = await hitlGate(decision.name, params, gatedActions, env.hitlGateway, runId, sessionId, notes);
        if (!allowed) {
          return withTokenUsage({ level, script_name: decision.name, result: { ok: false, error: "HITL rejected", tier: 1 as const, duration_ms: 0, tokens_used: 0 }, notes }, usage);
        }
        const result = await tools.run(decision.name, params);
        notes.push(`L2 patched ${decision.name}: ${result.ok ? "ok" : "fail"}`);
        // Automatic rollback on immediate failure (spec §10.3).
        if (!result.ok) {
          const meta = await tools.skillLibrary.readMetadata(decision.name);
          if (meta && meta.version > 1) {
            await tools.skillLibrary.rollback(decision.name, meta.version - 1);
            notes.push(`L2 rollback ${decision.name} → v${meta.version - 1}`);
          }
        }
        return withTokenUsage({ level, script_name: decision.name, result, distilled_script: decision.name, notes }, usage);
      }
      return withTokenUsage(await applyTerminalDecision(level, decision, tools, opts.goal, notes), usage);
    }

    case "L3":
    case "L4": {
      // Full re-derivation (L3) or live first-principles reasoning then distill (L4).
      const maxSteps = opts.maxSteps ?? 6;
      let lastDecision: ReasonDecision | null = null;
      const usageAcc = { input: 0, output: 0 };
      for (let step = 0; step < maxSteps; step++) {
        // Real per-token budget ceiling (sub-agent budgets — spec: enforce actual reasoner
        // spend, not a step-count proxy). Never starts a step it can't afford.
        if (opts.maxTokens && usageAcc.input + usageAcc.output >= opts.maxTokens) {
          notes.push(`${level} token budget ${opts.maxTokens} reached before step ${step + 1}`);
          break;
        }
        await reportProgress(opts, "step", `${level} step ${step + 1}/${maxSteps}`);
        const decision = await reasoner.decide({
          goal: opts.goal,
          level,
          snapshot,
          candidates,
          availableOperations: tools.availableOperations(),
          ...(level === "L3" && top
            ? { repairTarget: { name: top.name, failureReason: "stale / re-derive" } }
            : {}),
        });
        const stepUsage = usageOf(reasoner);
        usageAcc.input += stepUsage.input;
        usageAcc.output += stepUsage.output;
        lastDecision = decision;

        if (decision.action === "run") {
          // HITL gate before execution
          const allowed = await hitlGate(decision.name, decision.params, gatedActions, env.hitlGateway, runId, sessionId, notes);
          if (!allowed) {
            return withTokenUsage({ level, script_name: decision.name, result: { ok: false, error: "HITL rejected", tier: 1 as const, duration_ms: 0, tokens_used: 0 }, notes }, usageAcc);
          }
          const result = await tools.run(decision.name, decision.params);
          notes.push(`${level} run ${decision.name}: ${result.ok ? "ok" : "fail"}`);
          if (!result.ok) continue; // let the reasoner try another step
          return withTokenUsage({ level, script_name: decision.name, result, notes }, usageAcc);
        }

        if (decision.action === "distill" || decision.action === "patch") {
          return withTokenUsage(await applyTerminalDecision(level, decision, tools, opts.goal, notes), usageAcc);
        }

        if (decision.action === "answer" || decision.action === "give_up") {
          return withTokenUsage(await applyTerminalDecision(level, decision, tools, opts.goal, notes), usageAcc);
        }
      }
      notes.push(`${level} exhausted ${maxSteps} steps`);
      return withTokenUsage(
        await applyTerminalDecision(level, lastDecision ?? { action: "give_up", reason: "no decision" }, tools, opts.goal, notes),
        usageAcc
      );
    }
  }
}

/** Reads the reasoner's most recently reported usage; zeros when unreported. */
function usageOf(reasoner: Reasoner): { input: number; output: number } {
  const u = reasoner.lastUsage;
  return u ? { input: u.input_tokens, output: u.output_tokens } : { input: 0, output: 0 };
}

/**
 * Adds real reasoner token spend onto a LoopResult's result, if it carries one. Keeps the
 * input/output breakdown (not just the combined total) so the host can price it per-model —
 * input and output tokens are billed at different rates (spec §15 / billing-core pricing).
 */
function withTokenUsage(loopResult: LoopResult, usage: { input: number; output: number }): LoopResult {
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
  notes: string[]
): Promise<LoopResult> {
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
    const result = await tools.run(decision.name, decision.params);
    notes.push(`${level} distilled ${decision.name}: ${result.ok ? "ok" : "fail"}`);
    return { level, script_name: decision.name, result, distilled_script: decision.name, notes };
  }

  if (decision.action === "patch") {
    await tools.update(decision.name, { code: decision.code }, decision.reason);
    const result = await tools.run(decision.name, {});
    notes.push(`${level} patched ${decision.name}`);
    return { level, script_name: decision.name, result, distilled_script: decision.name, notes };
  }

  if (decision.action === "answer") {
    notes.push(`${level} answered directly`);
    return {
      level,
      result: { ok: true, output: decision.text, tier: 1, duration_ms: 0, tokens_used: 0 },
      notes,
    };
  }

  notes.push(`${level} gave up: ${decision.action === "give_up" ? decision.reason : "unknown"}`);
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
