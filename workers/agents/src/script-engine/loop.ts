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
} from "./types.js";
import { ScriptToolSurface } from "./tool-surface.js";
import { runObserve } from "./observe.js";
import { fingerprintSimilarity, isMatch, isPartial } from "./fingerprint.js";
import { FIND_CONFIDENCE_FLOOR } from "./script-find.js";

/** A decision the reasoning model returns when the library has no ready answer. */
export type ReasonDecision =
  | { action: "run"; name: string; params: Record<string, unknown> }
  | { action: "patch"; name: string; code: string; reason: string }
  | { action: "distill"; name: string; code: string; metadata: Partial<ScriptMetadata>; params: Record<string, unknown> }
  | { action: "answer"; text: string }
  | { action: "give_up"; reason: string };

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

  // 1-2. OBSERVE + FINGERPRINT
  const snapshot = await runObserve(env, opts.startupObserve, opts.observeArgs ?? {});
  notes.push(`observed ${snapshot.type} fingerprint=${snapshot.fingerprint.slice(0, 12)}`);

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

  // 5-7. EXECUTE / VERIFY / DISTILL per level.
  switch (level) {
    case "L1": {
      const result = await tools.run(top!.name, paramsFor(top!, opts.goal));
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
      if (decision.action === "patch") {
        await tools.update(decision.name, { code: decision.code }, decision.reason);
        const result = await tools.run(decision.name, paramsFor(top!, opts.goal));
        notes.push(`L2 patched ${decision.name}: ${result.ok ? "ok" : "fail"}`);
        // Automatic rollback on immediate failure (spec §10.3).
        if (!result.ok) {
          const meta = await tools.skillLibrary.readMetadata(decision.name);
          if (meta && meta.version > 1) {
            await tools.skillLibrary.rollback(decision.name, meta.version - 1);
            notes.push(`L2 rollback ${decision.name} → v${meta.version - 1}`);
          }
        }
        return { level, script_name: decision.name, result, distilled_script: decision.name, notes };
      }
      return applyTerminalDecision(level, decision, tools, opts.goal, notes);
    }

    case "L3":
    case "L4": {
      // Full re-derivation (L3) or live first-principles reasoning then distill (L4).
      const maxSteps = opts.maxSteps ?? 6;
      let lastDecision: ReasonDecision | null = null;
      for (let step = 0; step < maxSteps; step++) {
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
        lastDecision = decision;

        if (decision.action === "run") {
          const result = await tools.run(decision.name, decision.params);
          notes.push(`${level} run ${decision.name}: ${result.ok ? "ok" : "fail"}`);
          if (!result.ok) continue; // let the reasoner try another step
          // VERIFY passed → keep going only if the reasoner wants to; treat a successful
          // run as the terminal action for this simple driver.
          return { level, script_name: decision.name, result, notes };
        }

        if (decision.action === "distill" || decision.action === "patch") {
          return applyTerminalDecision(level, decision, tools, opts.goal, notes);
        }

        if (decision.action === "answer" || decision.action === "give_up") {
          return applyTerminalDecision(level, decision, tools, opts.goal, notes);
        }
      }
      notes.push(`${level} exhausted ${maxSteps} steps`);
      return applyTerminalDecision(level, lastDecision ?? { action: "give_up", reason: "no decision" }, tools, opts.goal, notes);
    }
  }
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
