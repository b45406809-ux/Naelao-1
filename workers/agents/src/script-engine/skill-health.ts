/**
 * Skill health — the recency layer that closes the self-improvement loop.
 *
 * We already recorded outcomes (`success_count` / `failure_count` → `stability_score`) and
 * sorted `script.find` by them. What that could never express is RECENCY. A skill with 20
 * successes and 4 failures scores 0.83 whether those four failures are spread across a year
 * or are the last four runs in a row — so a skill that broke yesterday kept being offered as
 * proven, kept being picked, and kept failing. A lifetime ratio is a reputation; it is not a
 * diagnosis.
 *
 * So `stability_score` stays exactly what it is (the lifetime signal, unchanged), and this
 * module adds the layer on top: a bounded window of the most recent runs INCLUDING why each
 * failed, and a verdict derived from it. Three things consume that verdict:
 *
 *   1. `script.find` folds it into confidence, so a broken skill stops out-ranking a working
 *      alternative — but is never hidden. An agent cannot repair a skill it can't see.
 *   2. The GATE refuses to auto-run a broken or degrading skill at L1 and routes it to repair
 *      instead, carrying the REAL last error as the repair target's failure reason — which is
 *      the difference between "fix this" and "fix this, here is what it said".
 *   3. The reasoner sees it per candidate, so the model can choose `patch` over `run` on its
 *      own rather than re-running something that has failed three times.
 *
 * Every function here is pure. The library persists the window; the loop and find consume it.
 */

import type { ScriptMetadata, SkillOutcome, SkillHealth, SkillHealthState } from "./types.js";

export type { SkillHealth, SkillHealthState };

/** How many recent runs to keep per skill. Enough to see a streak, small enough that the
 *  metadata object stays cheap to read on every `script.find` candidate. */
export const RECENT_OUTCOME_WINDOW = 10;

/** A recorded error is a diagnosis, not a log — keep the head and drop the stack. */
export const MAX_RECORDED_ERROR_CHARS = 240;

/** Consecutive recent failures before a skill is considered broken rather than unlucky. */
export const BROKEN_AFTER_CONSECUTIVE_FAILURES = 3;
/** Two in a row is not yet proof, but it is enough to stop trusting it unchanged. */
export const DEGRADING_AFTER_CONSECUTIVE_FAILURES = 2;
/** Below this many recorded runs a skill has no track record either way. */
export const PROVEN_MIN_RUNS = 3;

/** Append an outcome to the rolling window (newest first, bounded). */
export function recordRecentOutcome(
  existing: SkillOutcome[] | undefined,
  outcome: { ok: boolean; at: number; error?: string | undefined }
): SkillOutcome[] {
  const entry: SkillOutcome = { ok: outcome.ok, at: outcome.at };
  if (!outcome.ok && outcome.error) {
    entry.error = outcome.error.slice(0, MAX_RECORDED_ERROR_CHARS);
  }
  return [entry, ...(existing ?? [])].slice(0, RECENT_OUTCOME_WINDOW);
}

/**
 * Derive the verdict. Reads the recent window first (recency is the whole point) and falls
 * back to the lifetime counters only to distinguish "proven" from "never really run".
 */
export function assessSkillHealth(
  metadata: Pick<ScriptMetadata, "success_count" | "failure_count"> & {
    recent_outcomes?: SkillOutcome[] | undefined;
  }
): SkillHealth {
  const recent = metadata.recent_outcomes ?? [];
  const recentRuns = recent.length;
  const recentFailures = recent.filter((o) => !o.ok).length;
  const totalRuns = metadata.success_count + metadata.failure_count;

  let consecutive = 0;
  for (const o of recent) {
    if (o.ok) break;
    consecutive += 1;
  }

  const lastError = recent.find((o) => !o.ok && o.error)?.error;
  const withError = (base: string): string =>
    lastError ? `${base} Last error: ${lastError}` : base;

  if (consecutive >= BROKEN_AFTER_CONSECUTIVE_FAILURES) {
    return {
      state: "broken",
      consecutive_failures: consecutive,
      recent_runs: recentRuns,
      recent_failures: recentFailures,
      ...(lastError ? { last_error: lastError } : {}),
      recommendation: withError(
        `Broken — failed its last ${consecutive} runs. Do not run it unchanged; patch it against the recorded error, or take a different approach entirely.`
      ),
    };
  }

  if (consecutive >= DEGRADING_AFTER_CONSECUTIVE_FAILURES) {
    return {
      state: "degrading",
      consecutive_failures: consecutive,
      recent_runs: recentRuns,
      recent_failures: recentFailures,
      ...(lastError ? { last_error: lastError } : {}),
      recommendation: withError(
        `Degrading — failed its last ${consecutive} runs. Prefer patching it over running it unchanged.`
      ),
    };
  }

  // A skill can be failing badly without a clean streak (fails, works once, fails twice).
  if (recentRuns >= 4 && recentFailures / recentRuns > 0.5) {
    return {
      state: "degrading",
      consecutive_failures: consecutive,
      recent_runs: recentRuns,
      recent_failures: recentFailures,
      ...(lastError ? { last_error: lastError } : {}),
      recommendation: withError(
        `Degrading — ${recentFailures} of its last ${recentRuns} runs failed. Prefer patching it over running it unchanged.`
      ),
    };
  }

  if (totalRuns < PROVEN_MIN_RUNS) {
    return {
      state: "unproven",
      consecutive_failures: consecutive,
      recent_runs: recentRuns,
      recent_failures: recentFailures,
      ...(lastError ? { last_error: lastError } : {}),
      recommendation:
        totalRuns === 0
          ? "Never run — no track record. Check the result rather than assuming it worked."
          : `Unproven — only ${totalRuns} run(s) recorded. Check the result rather than assuming it worked.`,
    };
  }

  return {
    state: "proven",
    consecutive_failures: 0,
    recent_runs: recentRuns,
    recent_failures: recentFailures,
    recommendation:
      recentRuns > 0
        ? `Proven — ${recentRuns - recentFailures} of its last ${recentRuns} runs succeeded.`
        : `Proven — ${metadata.success_count} successes recorded.`,
  };
}

/**
 * How much a health verdict should move a candidate's ranking.
 *
 * A broken skill is heavily demoted but deliberately NOT dropped: it has to stay findable for
 * the agent to repair it, and its own recorded error is the best available input to that
 * repair. Demoting it is enough — anything that actually works will out-rank it.
 */
export function healthConfidenceMultiplier(state: SkillHealthState): number {
  switch (state) {
    case "broken":
      return 0.15;
    case "degrading":
      return 0.5;
    case "unproven":
      return 0.9;
    case "proven":
      return 1;
  }
}

/** Whether the GATE may run this skill directly, with no model in the loop. */
export function isSafeToAutoRun(state: SkillHealthState): boolean {
  return state === "proven";
}
