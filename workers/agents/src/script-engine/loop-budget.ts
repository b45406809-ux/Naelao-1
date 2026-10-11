/**
 * What actually stops an agent loop.
 *
 * The gap this closes
 * -------------------
 * The loop ran `for (let step = 0; step < (opts.maxSteps ?? 6); step++)`. Six turns, and the
 * interactive chat path never overrode it — so every message a user sent got six chances to reason,
 * call tools and compose an answer, no matter what they asked for. Any task needing "look this up,
 * then check that, then act, then verify" ran out mid-way and was reported as
 * "Ran 6 step(s) without reaching an answer".
 *
 * OpenClaw, the closest comparable, has no step cap at all: its loop runs until the model stops
 * requesting tools, with compaction keeping the context inside the model's budget. That is the
 * right shape — a step count is a proxy for nothing anyone cares about. Nobody wants "six tool
 * calls"; they want the work done, within a cost they can live with, before they give up waiting.
 *
 * So the loop is bounded by the things that are actually scarce:
 *   - TOKENS, the real currency (the reasoner reports genuine usage per call, not an estimate)
 *   - WALL CLOCK, because somebody is waiting on the other end of a request
 *   - PROGRESS, because a model failing the same way six times running will fail a seventh
 *   - a runaway ceiling far above normal use, which should never be the thing that fires
 *
 * The distinction that makes this usable rather than merely permissive is `final`: one turn before
 * a budget runs out, the model is told so, and answers with what it has. Without that, hitting a
 * budget is indistinguishable from failing — which is precisely how a run that had genuinely
 * created a project came to be reported as an error, prompting a retry that created a second one.
 *
 * Pure by design: the clock is an argument, not a call. Budget arithmetic is exactly the kind of
 * thing that should be testable without a Durable Object.
 */

export interface LoopBudget {
  /**
   * Runaway ceiling, NOT an operating limit. Reaching this means something is wrong — a model
   * stuck in a pattern the stall detector somehow didn't catch — so it is set far above what real
   * work needs rather than at a level tasks routinely bump into.
   */
  maxSteps: number;
  /** Real reasoner token ceiling for the whole run, measured from the provider's own usage counts. */
  maxTokens?: number | undefined;
  /** Epoch ms after which no new step may start. Absent = no wall-clock limit (the durable path). */
  deadlineAt?: number | undefined;
  /**
   * Consecutive reasoning steps that produced no successful tool result before the loop stops and
   * asks for a summary. Guards the case a step count used to accidentally guard: a model looping on
   * a failing approach. Six is deliberately generous — a real agent recovering from a bad call
   * usually does it within two.
   */
  maxStallSteps: number;
}

/**
 * Defaults for an interactive run.
 *
 * 50 steps is roughly eight times the old cap and beyond what any real task has needed in
 * practice; it exists to catch a pathology, not to shape behaviour. The token ceiling is what
 * actually bounds cost, and at the platform's default model it is worth a fraction of a cent —
 * generous enough that a long research task completes, small enough that a runaway is bounded.
 *
 * Spend is separately capped per session by `sessionCreditCeiling` (the session budget guard), so
 * this ceiling is a per-run backstop rather than the only thing standing between a user and a bill.
 */
export const DEFAULT_LOOP_BUDGET: LoopBudget = {
  maxSteps: 50,
  maxTokens: 120_000,
  maxStallSteps: 6,
};

export interface BudgetState {
  /** 0-based index of the step about to start. */
  step: number;
  /** Reasoner tokens spent so far this run (input + output). */
  tokensUsed: number;
  /** Consecutive steps with no successful tool result. */
  stallSteps: number;
  /** Current time, injected so this stays pure. */
  now: number;
  /**
   * The longest single step observed so far, in ms. Used to judge whether there is room for
   * another one before the deadline — a fixed margin would either cut runs short on a fast model
   * or blow through the deadline on a slow one.
   */
  longestStepMs: number;
}

export type BudgetVerdict =
  | { verdict: "continue" }
  /** Room for exactly one more turn. The model is told, and must finish. */
  | { verdict: "final"; reason: string }
  /** No room for another turn at all. */
  | { verdict: "exhausted"; reason: string };

/** Floor for the deadline margin. A step that has only ever taken 200ms can still take seconds on
 *  a slow provider call, so "there's 5 seconds left, one more won't hurt" is not a safe read. */
const MIN_DEADLINE_MARGIN_MS = 15_000;

/** Room to reserve for one more reasoning round: the payload plus the reply's max_tokens. Starting
 *  a step there is no budget to finish spends real money on a call whose result is discarded. */
const TOKEN_MARGIN = 6_000;

/**
 * Decide whether the loop may take another step, must make this its last, or must stop now.
 *
 * Checked in order of how expensive the mistake would be to get wrong: a blown deadline strands a
 * caller, a blown token budget costs money, a stall wastes both.
 */
export function assessBudget(budget: LoopBudget, state: BudgetState): BudgetVerdict {
  if (state.step >= budget.maxSteps) {
    return { verdict: "exhausted", reason: `reached the ${budget.maxSteps}-step runaway ceiling` };
  }
  if (state.stallSteps >= budget.maxStallSteps) {
    return { verdict: "exhausted", reason: `${state.stallSteps} steps in a row made no progress` };
  }
  if (budget.deadlineAt !== undefined) {
    const margin = Math.max(MIN_DEADLINE_MARGIN_MS, state.longestStepMs);
    if (state.now >= budget.deadlineAt) return { verdict: "exhausted", reason: "ran out of time" };
    if (state.now + margin >= budget.deadlineAt) return { verdict: "final", reason: "almost out of time" };
  }
  if (budget.maxTokens !== undefined) {
    if (state.tokensUsed >= budget.maxTokens) {
      return { verdict: "exhausted", reason: `used the whole ${budget.maxTokens}-token budget` };
    }
    if (state.tokensUsed + TOKEN_MARGIN >= budget.maxTokens) {
      return { verdict: "final", reason: "almost out of token budget" };
    }
  }
  // One step short of the ceiling, or one stall short of the stall limit: this is the last turn.
  if (state.step === budget.maxSteps - 1) return { verdict: "final", reason: "last step available" };
  if (state.stallSteps === budget.maxStallSteps - 1) return { verdict: "final", reason: "no progress for several steps" };
  const decision = deterministicChoice("continue", "loop_budget_within_limits");
  return { verdict: decision.value };
}

/**
 * Merge caller overrides onto the defaults.
 *
 * `maxTokens: null` explicitly means "no token ceiling" (the durable/background path, where the
 * enclosing job owns the budget), which is a different thing from omitting it and inheriting the
 * default — so it has to be expressible.
 */
export function resolveLoopBudget(overrides?: Partial<LoopBudget> & { maxTokens?: number | null }): LoopBudget {
  const o = overrides ?? {};
  return {
    maxSteps: typeof o.maxSteps === "number" && o.maxSteps > 0 ? o.maxSteps : DEFAULT_LOOP_BUDGET.maxSteps,
    maxTokens: o.maxTokens === null ? undefined : typeof o.maxTokens === "number" ? o.maxTokens : DEFAULT_LOOP_BUDGET.maxTokens,
    ...(typeof o.deadlineAt === "number" ? { deadlineAt: o.deadlineAt } : {}),
    maxStallSteps:
      typeof o.maxStallSteps === "number" && o.maxStallSteps > 0 ? o.maxStallSteps : DEFAULT_LOOP_BUDGET.maxStallSteps,
  };
}

/**
 * Whether a provider error is the model's context window overflowing, as opposed to any other
 * failure. Worth distinguishing because it is the one error with a real recovery: drop history and
 * try again. Everything else genuinely is a failure.
 *
 * Matched on message text because there is no shared error code across providers — Anthropic,
 * OpenAI-compatible endpoints and Workers AI all word this differently, and the CF AI Gateway
 * passes the upstream text through rather than normalising it.
 */
export function isContextOverflowError(message: string): boolean {
  const m = message.toLowerCase();
  if (m.includes("context") && (m.includes("length") || m.includes("window") || m.includes("overflow"))) return true;
  if (m.includes("too many tokens") || m.includes("maximum context")) return true;
  if (m.includes("prompt is too long") || m.includes("input is too long")) return true;
  // OpenAI-compatible endpoints (which is the shape Workers AI serves) use this code verbatim.
  if (m.includes("context_length_exceeded")) return true;
  return false;
}
import { deterministicChoice } from "@naelao/agent-sdk";
