/**
 * Sub-agent output hygiene (spec "Advanced Agent SDK Patterns" §3 + appendix gap
 * G-AN24 "Sub-Agent Output Schema Enforcement: Preventing Instruction Injection via Agent
 * Output"). A child agent's result is DATA to the parent, never instructions — the same
 * trust boundary as an external tool result (see NaelaoAgentDO's dispatchTool, which wraps
 * http_get responses in <untrusted_tool_result>). Pulled out of NaelaoAgentDO so it's
 * unit-testable without a Durable Object harness.
 */

import { moderateInput } from "@naelao/llm-gateway";

const MAX_SUB_AGENT_OUTPUT_CHARS = 8_000;

/** Sub-agent fan-out bound (G-4049155) — same order of magnitude as Claude Code's own
 *  orchestrator-subagent pattern ("up to 16 subagents"), not an arbitrary number. */
export const MAX_SUB_AGENTS_PER_SPAWN = 16;
export const DEFAULT_SUB_AGENT_BUDGET_TOKENS = 20_000;

/** Account-level concurrency ceiling (spec §28 ConcurrencyDO) — how many separate spawn
 *  TREES (batched agent.spawn calls) can be running at once per space, independent of
 *  MAX_SUB_AGENTS_PER_SPAWN's within-tree fan-out bound. Enforced via ConcurrencyDO when
 *  bound; ungated when it isn't (honest degradation, same as every other optional binding). */
export const MAX_CONCURRENT_SUB_AGENT_TREES = 3;

/**
 * Coarse budget→step translation — a secondary safety net alongside the loop's real
 * per-token enforcement (runScriptLoop's `maxTokens`, backed by the reasoner's actual
 * Anthropic `usage` counts, not an estimate). Bounds runaway step count even in the rare case
 * usage isn't reported (e.g. a non-standard model response). Each child gets its OWN ceiling
 * derived from ITS OWN requested budget, never the parent's remaining budget (fixes
 * "Sub-Agent Token Budget Not Isolated From Parent").
 */
export function budgetToMaxSteps(budgetTokens: number): number {
  return Math.max(1, Math.min(10, Math.round(budgetTokens / 2000)));
}

/** Caps size (context-bloat guard) and wraps a sub-agent's output so it can never be read
 *  as instructions by the parent's reasoning model — scans for injection patterns first. */
export function sanitizeSubAgentOutput(output: unknown): string | undefined {
  if (output === undefined) return undefined;
  const text = typeof output === "string" ? output : JSON.stringify(output);
  const truncated = text.length > MAX_SUB_AGENT_OUTPUT_CHARS ? `${text.slice(0, MAX_SUB_AGENT_OUTPUT_CHARS)}\n[TRUNCATED]` : text;
  const mod = moderateInput(truncated);
  const safe = mod.blocked ? "[REDACTED: sub-agent output flagged by moderation]" : truncated;
  return `<untrusted_subagent_result>\n${safe}\n</untrusted_subagent_result>`;
}

/** Parses a stored JSON string back to a value; falls back to the raw string if it isn't JSON. */
export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
