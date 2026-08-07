/**
 * Effort — a single per-model dial that does two jobs at once, deliberately unified rather than
 * two separate controls:
 *
 *  1. Sets the active model's OWN reasoning/thinking depth, when it has one
 *     (MODEL_CAPABILITIES' reasoningLevels — a plain wire param like gpt-oss's `reasoning_effort`
 *     or Kimi's `chat_template_kwargs.thinking`).
 *  2. Sets the ESCALATION BUDGET for any work this run delegates — a sub-agent spawn or a
 *     consult — so a person who picked a cheap model specifically to control cost doesn't get
 *     surprised by that cheap model quietly calling a much more expensive one on its behalf.
 *     This is the actual problem this file exists to solve: choosing a weak/cheap model to save
 *     money is meaningless if the moment it needs help it reaches for the most expensive model
 *     available. Effort is the knob that keeps that decision under the person's own control.
 *
 * Every model gets at least "low" and "medium" — even one with no native reasoning capability at
 * all still has a real escalation-budget difference between "delegate to the cheapest model
 * only" (low) and "delegate to the next tier up if it's actually needed" (medium). Levels beyond
 * that (high, ultra) only appear for models whose own reasoningLevels ladder is deep enough to
 * make them meaningfully distinct — offering a 4th tier on a model with no reasoning capability
 * at all would just be two buttons doing the same thing.
 */

import { capabilityForModel, type AllowedModel, ALLOWED_MODELS, DEFAULT_WORKING_MODEL } from "./models.js";
import { costRankForModel, benchmarkForModel } from "./model-benchmarks.js";

export const EFFORT_LEVELS = ["low", "medium", "high", "ultra"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export interface EffortOption {
  level: EffortLevel;
  label: string;
  description: string;
}

const EFFORT_DESCRIPTIONS: Record<EffortLevel, string> = {
  low:
    "Lowest cost. If this needs help from another model, it only ever calls the single cheapest " +
    "model available — never something pricier than what you're already paying for.",
  medium:
    "Balanced. If this needs help, it can call the next model up from what you're on — a real " +
    "step up in capability, but not the most expensive option on the table.",
  high:
    "Prioritizes quality. Can call a near-top-tier model when the task genuinely calls for it, " +
    "at meaningfully higher cost than low or medium.",
  ultra:
    "Maximum capability. Always uses the best available model for anything delegated — no cost " +
    "ceiling. Use this when getting it right matters more than what it costs.",
};

/** Highest cost rank among curated models — the "no ceiling" case ultra resolves to. */
const MAX_COST_RANK = Math.max(...ALLOWED_MODELS.map((m) => costRankForModel(m)));

/**
 * Which effort levels a given model actually offers, and what each maps to. Every model gets
 * low + medium unconditionally; higher tiers appear only as deep as the model's own native
 * reasoning ladder goes (0 native levels -> 2 effort levels, 2 native levels -> 3, 3+ native
 * levels -> 4) — "based on the model," per the product ask, rather than a fixed set for every
 * model regardless of what it can actually do with a deeper setting.
 */
export function effortLadderForModel(model: string): EffortOption[] {
  const cap = capabilityForModel(model);
  const n = cap.reasoningLevels.length;
  const count = n === 0 ? 2 : n === 1 ? 2 : n === 2 ? 3 : 4;
  return EFFORT_LEVELS.slice(0, count).map((level) => ({
    level,
    label: level[0]!.toUpperCase() + level.slice(1),
    description: EFFORT_DESCRIPTIONS[level],
  }));
}

/** Whether `level` is one this model's own ladder actually offers. */
export function isValidEffortLevel(model: string, level: string): level is EffortLevel {
  return effortLadderForModel(model).some((o) => o.level === level);
}

/**
 * The model's own native reasoning-effort wire value for a chosen Effort level, or null when the
 * model has no configurable reasoning at all.
 *
 * Rule: native reasoning depth rises together with Effort, saturating at the model's own maximum
 * once Effort has more positions than the model has native levels for — `nativeIdx = min(idx,
 * levels.length - 1)`. This gives an exact 1:1 mapping for a model whose native ladder is deep
 * enough to have one slot per Effort level below "ultra" (e.g. gpt-oss's low/medium/high maps
 * onto Effort's low/medium/high exactly, with only "ultra" clamped to its own top), and a clean,
 * defensible saturation for a shallower model (a 2-level model like glm-5.2 or Kimi reaches its
 * own top reasoning depth once Effort hits "medium", staying there for "high" too — there's no
 * meaningful third native position to reserve for "high" alone). Generic, not a per-model table,
 * so a future model added to MODEL_CAPABILITIES with its own reasoningLevels shape is handled
 * automatically.
 */
export function nativeReasoningForEffort(model: string, effort: EffortLevel): string | null {
  const cap = capabilityForModel(model);
  const levels = cap.reasoningLevels;
  if (levels.length === 0) return null;
  const ladder = effortLadderForModel(model);
  const idx = ladder.findIndex((o) => o.level === effort);
  if (idx < 0) return levels[levels.length - 1] ?? null;
  const nativeIdx = Math.min(levels.length - 1, idx);
  return levels[nativeIdx] ?? null;
}

/**
 * The highest cost rank a delegated model call may use, given the CURRENT model's own rank and
 * the chosen Effort level. This is the enforcement point: "low" pins delegation to the cheapest
 * model that exists (rank 1) regardless of what the current model itself costs — the literal
 * "tries to call no-costing model[s]" behavior asked for. "ultra" removes the ceiling entirely.
 */
export function escalationCeiling(currentModel: string, effort: EffortLevel): number {
  const currentRank = costRankForModel(currentModel);
  switch (effort) {
    case "low":
      return 1;
    case "medium":
      return Math.min(MAX_COST_RANK, currentRank + 1);
    case "high":
      return Math.max(currentRank, MAX_COST_RANK - 1);
    case "ultra":
      return MAX_COST_RANK;
  }
}

export interface EscalationResolution {
  model: AllowedModel;
  /** True when a specifically-requested model was clamped down to something cheaper because it
   *  exceeded the current Effort level's ceiling. */
  downgraded: boolean;
  /** Present whenever `downgraded` is true — the honest, user-facing explanation asked for:
   *  "tried to run an expensive model, got an error message, moved down to cheaper." */
  reason?: string;
}

/**
 * Resolves which model a delegated call (a sub-agent spawn, a consult) is actually allowed to
 * run on, given the parent run's own model + Effort setting.
 *
 * - With no `preferModel` (the caller just wants "the best model I can afford"), returns the
 *   highest-ranked model at or under the ceiling.
 * - With a `preferModel` (the caller asked for something specific), returns it unchanged when
 *   it's within budget; otherwise clamps to the best model still within budget and reports why —
 *   never silently runs the requested model over its Effort ceiling, and never hard-fails either
 *   (a downgrade, not a refusal, per the product's own "get an error message and move down to
 *   cheaper" — the caller is told, then still gets a working, cheaper model).
 */
export function resolveEscalationModel(
  currentModel: string,
  effort: EffortLevel,
  opts?: { preferModel?: string | undefined }
): EscalationResolution {
  const ceiling = escalationCeiling(currentModel, effort);
  const affordable = ALLOWED_MODELS.filter((m) => costRankForModel(m) <= ceiling);
  // Prefer the affordable model with the best measured/estimated capability — cost rank first
  // (higher within budget is "better" here). ALLOWED_MODELS lists Claude ids first, but Claude
  // is not reachable on every deployment (see DEFAULT_WORKING_MODEL's own doc — this account's
  // AI Gateway has no Anthropic provider at all), so a bare "first in list order" tiebreak among
  // same-rank candidates could resolve to a model that 404s in production. Break ties toward
  // DEFAULT_WORKING_MODEL — the one model every deployment is guaranteed to have working — when
  // it's among the top affordable tier; otherwise curated order stands (a real, documented
  // limitation for ties outside that tier, same as model-benchmarks.ts's own note on cost-tier
  // ties in general).
  const maxAffordableRank = affordable.length > 0 ? Math.max(...affordable.map((m) => costRankForModel(m))) : costRankForModel(currentModel);
  const topTier = affordable.filter((m) => costRankForModel(m) === maxAffordableRank);
  const best: AllowedModel = topTier.includes(DEFAULT_WORKING_MODEL) ? DEFAULT_WORKING_MODEL : (topTier[0] ?? (currentModel as AllowedModel));

  const prefer = opts?.preferModel;
  if (!prefer) {
    return { model: best, downgraded: false };
  }
  const preferRank = costRankForModel(prefer);
  if (preferRank <= ceiling && ALLOWED_MODELS.includes(prefer as AllowedModel)) {
    return { model: prefer as AllowedModel, downgraded: false };
  }
  const preferLabel = benchmarkForModel(prefer)?.family ?? prefer;
  return {
    model: best,
    downgraded: true,
    reason: `"${preferLabel}" costs more than your Effort setting ("${effort}") allows for delegated work — used "${benchmarkForModel(best)?.family ?? best}" instead.`,
  };
}

/** Convenience: the full set of {level, label, description} options for a model, in a shape a
 *  settings/dock UI can render directly without re-deriving anything. */
export function effortOptionsForModel(model: string): EffortOption[] {
  return effortLadderForModel(model);
}
