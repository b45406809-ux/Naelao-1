/**
 * In-loop step compaction — what makes an unbounded agent loop actually possible.
 *
 * The gap this closes
 * -------------------
 * The loop fed EVERY step it had taken back into the reasoner payload as `steps_so_far`, growing
 * forever. Each observation is capped at 2000 chars (~500 tokens), so twenty steps is ~10k tokens
 * of history alone — and this platform's default model is served with a REAL 24k window
 * (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`; see billing-core's MODEL_CONTEXT_WINDOWS, read from
 * the account's own /ai/models/search rather than the model's nominal figure).
 *
 * That is the actual reason the loop was capped at six steps. Raising the cap without this module
 * does not remove the limit, it just moves the failure: instead of "ran 6 steps without reaching an
 * answer" the agent would overflow its context somewhere around step twenty-five and every
 * subsequent call would fail, which is a strictly worse outcome because it fails opaquely.
 *
 * Why the digest is deterministic rather than model-written
 * ---------------------------------------------------------
 * OpenClaw compacts by asking a model to summarise. That is the right call for a conversation,
 * where meaning lives in prose. It is the wrong call here for two reasons: it puts an extra LLM
 * round-trip on the hot path of every long run (real money on an account with a ~65-run/day free
 * allowance), and it introduces a failure mode where a summariser outage silently loses the record
 * of work that actually happened.
 *
 * What a model needs from an old step is not its payload — it is three facts: this ran, with these
 * arguments, and here is how it went. Those are structural and can be rendered exactly, for free,
 * with no possibility of a hallucinated summary claiming an action succeeded when it failed. The
 * details are what get dropped; the ledger of what was done never does.
 *
 * Pure by design: no clock, no storage, no network. The budgeting edge cases are where the bugs
 * live and they should be testable without a Durable Object.
 */

/** One executed step, as the loop records it in `priorSteps`. */
export interface LoopStep {
  name: string;
  params: Record<string, unknown>;
  ok: boolean;
  output?: unknown;
  error?: string;
}

export interface StepContextLimits {
  /** Token budget for the whole steps block of the reasoner payload. */
  maxTokens: number;
  /**
   * Always carry at least this many of the most recent steps verbatim, even if they blow the
   * budget on their own. A model that can see the digest but not a single real observation cannot
   * act on what it just learned, which defeats the point of running the step at all.
   */
  keepRecent: number;
  /** Single observations longer than this are truncated rather than allowed to evict the rest. */
  maxObservationChars: number;
}

export const DEFAULT_STEP_CONTEXT_LIMITS: StepContextLimits = {
  maxTokens: 6000,
  keepRecent: 3,
  maxObservationChars: 2000,
};

/** The bounded view of this run's own history handed to the reasoner. */
export interface CompactedSteps {
  /** Most recent steps, oldest first, carried in full. */
  recent: LoopStep[];
  /** One line per folded step: what ran, with what, and how it went. Empty when nothing folded. */
  digest: string[];
  /** How many steps were folded into the digest. */
  omitted: number;
  /** True when anything was folded — the model is told so explicitly. */
  compacted: boolean;
}

/** Rough token estimate. chars/4 is the convention already used across this codebase for
 *  budgeting (see conversation-context.ts); an estimate for sizing, never for billing. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function asText(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : safeStringify(value);
}

/** JSON.stringify that survives a cyclic or otherwise unserialisable tool result. A step whose
 *  output can't be stringified must still be countable and describable — losing the whole history
 *  because one tool returned something odd is exactly the failure this module exists to prevent. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** What one step costs in the payload, including the structural overhead of its own JSON. */
export function estimateStepTokens(step: LoopStep, maxObservationChars: number): number {
  const body = step.ok ? truncate(asText(step.output), maxObservationChars) : String(step.error ?? "failed").slice(0, 500);
  return estimateTokens(step.name) + estimateTokens(safeStringify(step.params)) + estimateTokens(body) + 12;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}… [truncated, ${text.length} chars total]`;
}

/** A copy of the step with its observation cut to the budget. Never mutates the input — the caller's
 *  array is the one that backs checkpoints and must keep the real values. */
function truncateStepOutput(step: LoopStep, maxChars: number): LoopStep {
  if (!step.ok) return step;
  const text = asText(step.output);
  if (text.length <= maxChars) return step;
  return { ...step, output: truncate(text, maxChars) };
}

/**
 * One folded step, rendered as a single line.
 *
 * Deliberately keeps the ARGUMENTS as well as the name. "project.create ran" is not enough for a
 * model to avoid repeating itself — it needs to know it created a project *called that one*, or it
 * will reasonably conclude a different project still needs creating. Arguments are what make the
 * digest a guard against duplicate work rather than a vague reassurance.
 */
export function summarizeStep(step: LoopStep, index: number): string {
  const params = safeStringify(step.params ?? {});
  const args = params.length > 160 ? `${params.slice(0, 160)}…` : params;
  if (!step.ok) {
    const err = String(step.error ?? "failed");
    return `${index}. ${step.name}(${args}) → FAILED: ${err.length > 160 ? `${err.slice(0, 160)}…` : err}`;
  }
  const out = asText(step.output).replace(/\s+/g, " ").trim();
  if (!out) return `${index}. ${step.name}(${args}) → ok`;
  return `${index}. ${step.name}(${args}) → ok: ${out.length > 160 ? `${out.slice(0, 160)}…` : out}`;
}

/**
 * Fit this run's history into `limits.maxTokens`.
 *
 * Walks backwards from the newest so the most recent observations always survive — an agent that
 * kept step 1 and dropped the result it just received could not act on it, which is the opposite of
 * what a history is for.
 */
export function compactSteps(
  steps: LoopStep[],
  limits: StepContextLimits = DEFAULT_STEP_CONTEXT_LIMITS
): CompactedSteps {
  const all = Array.isArray(steps) ? steps.filter((s): s is LoopStep => Boolean(s) && typeof s.name === "string") : [];
  if (all.length === 0) return { recent: [], digest: [], omitted: 0, compacted: false };

  const recent: LoopStep[] = [];
  let used = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const cost = estimateStepTokens(all[i]!, limits.maxObservationChars);
    // keepRecent wins over the budget on purpose — see its doc.
    if (used + cost > limits.maxTokens && recent.length >= limits.keepRecent) break;
    // Truncated HERE rather than downstream in the reasoner, and into a COPY: the loop owns the
    // budget, so it must send what it costed. The originals stay whole because the same array
    // backs resume checkpoints and deferred-approval records, which need the real results.
    recent.unshift(truncateStepOutput(all[i]!, limits.maxObservationChars));
    used += cost;
  }

  const omitted = all.length - recent.length;
  if (omitted === 0) return { recent, digest: [], omitted: 0, compacted: false };

  // The digest is 1-indexed against the ORIGINAL run, so "step 4" in the digest and "step 4" in the
  // trace/notes are the same step. Renumbering from 1 would silently misalign them.
  const digest = all.slice(0, omitted).map((s, i) => summarizeStep(s, i + 1));
  return { recent, digest, omitted, compacted: true };
}

/**
 * Render the compacted history into the shape the reasoner payload carries.
 *
 * The `notice` is not decoration. Claude Code's own compaction has a documented failure mode where
 * the assistant treats anything absent from the summary as never having happened; this codebase
 * already fights that for conversations (conversation-context.ts) and the same rule applies here.
 * Saying plainly "these ran, their full results are gone" is what stops the model re-running an
 * action whose payload it can no longer see.
 */
export function renderStepsForReasoner(
  recentSteps: LoopStep[],
  digest: string[],
  maxObservationChars: number
): Record<string, unknown> {
  const recent = recentSteps.map((s) => ({
    ran: s.name,
    params: s.params,
    ok: s.ok,
    // Tool output is UNTRUSTED data (it can carry text from a customer, a web page, a third-party
    // API). Presented as an observation, never as instructions — the system prompt says so — and
    // truncated so one large result can't crowd out the rest of the payload.
    ...(s.ok
      ? { result: truncate(asText(s.output), maxObservationChars) }
      : { error: String(s.error ?? "failed").slice(0, 500) }),
  }));
  if (digest.length === 0) return { steps_so_far: recent };
  return {
    steps_so_far: recent,
    earlier_steps: digest,
    steps_notice:
      `${digest.length} earlier step(s) in this task are listed under "earlier_steps" as a ` +
      "one-line record each — what ran, with what arguments, and how it went. Their full results " +
      "are no longer in context. Treat them as DONE: do not run them again. If you need the detail " +
      "of one of them, re-run it only when the goal genuinely requires the value, never to refresh " +
      "your memory of it.",
  };
}

/**
 * A budget for the steps block, sized against the model's real context window.
 *
 * The reasoner payload also carries the conversation (3k), the observation snapshot, the candidate
 * scripts and the system prompt, and the model needs room to actually reply (1500 output tokens).
 * Giving the step history a third of the window leaves the rest of the payload the space it needs
 * on a small model without pointlessly starving it on a large one.
 */
/**
 * Halve what the step history is allowed to carry, after the model reported its context
 * overflowing anyway.
 *
 * The budget above is sized from a per-model table and a chars/4 estimate, so it can be wrong in
 * the direction that matters — an unusually dense payload, or a served window smaller than the
 * table says. Rather than guess at a better estimate, take the model's own report as ground truth
 * and back off hard. `keepRecent` drops to 1 because on the second overflow the choice is between
 * carrying one real observation and carrying none at all.
 */
export function squeezeStepLimits(limits: StepContextLimits): StepContextLimits {
  return {
    maxTokens: Math.max(500, Math.floor(limits.maxTokens / 2)),
    keepRecent: Math.max(1, limits.keepRecent - 1),
    maxObservationChars: Math.max(400, Math.floor(limits.maxObservationChars / 2)),
  };
}

export function stepLimitsForModel(contextWindowTokens: number): StepContextLimits {
  const budget = Math.max(2000, Math.floor(contextWindowTokens / 3));
  return {
    maxTokens: budget,
    keepRecent: DEFAULT_STEP_CONTEXT_LIMITS.keepRecent,
    // On a genuinely small window, a single 2000-char observation is a tenth of everything. Scale
    // the per-observation cap down with the window rather than letting one tool result dominate.
    maxObservationChars: contextWindowTokens < 32_000 ? 1200 : DEFAULT_STEP_CONTEXT_LIMITS.maxObservationChars,
  };
}
