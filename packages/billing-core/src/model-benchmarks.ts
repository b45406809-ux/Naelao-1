/**
 * Model Benchmarks — what every model an agent can run on is actually good at, and what it
 * costs, so an agent (or a person) can pick "the next best model for this task" instead of only
 * ever knowing "I am running on X."
 *
 * Two kinds of numbers live here, kept honestly separate rather than blended into one fake score:
 *
 *  - `eval`: REAL numbers measured on OUR OWN production reasoning loop, from
 *    `docs/MODEL_EVAL_2026-07-25.md` (`workers/eval` in `mode: "agent"` — a real `/agent/run`
 *    per case, judged by an LLM judge). Only present for the 7 models actually run through that
 *    harness on `tool-use-policy.jsonl`. This is the most trustworthy number here because it
 *    measures the model doing THIS platform's own job, not a generic benchmark.
 *  - `costTier`/`paramsBasis`: cost tier is derived from real measured USD pricing where we have
 *    it (`computeTokenCostMicro`'s pricing table — currently llama-3.3-70b and the three Claude
 *    ids), and from PUBLISHED parameter counts otherwise (a real, sourceable fact — model family
 *    naming/active-parameter counts — used as a cost proxy, not a fabricated price). Never
 *    presented as a measured $ figure when it isn't one.
 *
 * "free APIs that give benchmark results" (LMSYS Arena, Artificial Analysis, etc.) were
 * considered and deliberately NOT wired in here: none of them score against THIS platform's own
 * agent loop / tool-calling contract, which is what actually matters for picking a model here —
 * see MODEL_EVAL_2026-07-25.md's own finding that raw score and tool-use reliability are not the
 * same axis. A generic leaderboard number would look precise while measuring the wrong thing.
 * Revisit if a well-known free benchmark ever publishes numbers for THESE exact model ids run in
 * an agentic/tool-calling harness.
 */

import { ALLOWED_MODELS, type AllowedModel } from "./models.js";

export type CostTier = "economy" | "standard" | "premium";

export interface ModelEvalResult {
  /** Which real eval dataset this was measured on. */
  dataset: string;
  /** 0-10, this platform's own LLM-judge score — see MODEL_EVAL_2026-07-25.md's own caveats
   *  before treating this as a general capability score; it is specific to that one dataset. */
  avgScore: number;
  /** "5/6" style — how often the model produced an actionable tool-call decision at all. The
   *  eval doc's own finding: this matters more than avgScore, since a model that cannot hold the
   *  tool contract is not a worse agent, it is not an agent. */
  usable: string;
  note: string;
}

export interface ModelBenchmark {
  id: AllowedModel;
  family: string;
  costTier: CostTier;
  /** "measured" = real per-token USD pricing (computeTokenCostMicro's own table); "estimated" =
   *  derived from the model's published parameter count as a cost proxy, not a fabricated price. */
  costBasis: "measured" | "estimated";
  /** What actually sets the cost-tier estimate — kept visible rather than a bare label so nobody
   *  mistakes an estimate for a measurement. */
  costNote: string;
  strengths: string[];
  bestFor: string[];
  eval?: ModelEvalResult;
}

const M = (
  id: AllowedModel,
  family: string,
  costTier: CostTier,
  costBasis: "measured" | "estimated",
  costNote: string,
  strengths: string[],
  bestFor: string[],
  evalResult?: ModelEvalResult
): ModelBenchmark => ({
  id,
  family,
  costTier,
  costBasis,
  costNote,
  strengths,
  bestFor,
  ...(evalResult ? { eval: evalResult } : {}),
});

const TOOL_USE_DATASET = "tool-use-policy.jsonl (this platform's own agent loop, 2026-07-25)";

export const MODEL_BENCHMARKS: Record<AllowedModel, ModelBenchmark> = {
  "claude-haiku-4-5-20251001": M(
    "claude-haiku-4-5-20251001", "Claude", "economy", "measured",
    "$0.25 / $1.25 per 1M tokens in / out — Anthropic's own published pricing.",
    ["Fast, cheap, reliable tool calling", "Good instruction-following for its price"],
    ["High-volume chat", "Simple lookups and short tasks", "Background/system wake-ups"]
  ),
  "claude-sonnet-4-6": M(
    "claude-sonnet-4-6", "Claude", "standard", "measured",
    "$3 / $15 per 1M tokens in / out — Anthropic's own published pricing.",
    ["Strong general reasoning", "Reliable multi-step tool use", "Good code and writing quality"],
    ["Default assistant work", "Multi-step business tasks", "Content generation"]
  ),
  "claude-opus-4-8": M(
    "claude-opus-4-8", "Claude", "premium", "measured",
    "$15 / $75 per 1M tokens in / out — Anthropic's own published pricing, the most expensive model on this list.",
    ["Best-in-class reasoning depth", "Handles ambiguous, high-stakes tasks"],
    ["Hard judgement calls", "Complex multi-step planning", "Escalation target when a cheaper model gets stuck"]
  ),
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": M(
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "Llama", "economy", "measured",
    "Derived from 3 real measured calls against this account's own neuron billing (~$0.29 / $2.25 per 1M in/out equivalent).",
    ["The only model in our own eval that held the tool contract on every single case (6/6 usable)", "Predictable — never loops or ignores its tools"],
    ["Default working model", "Anything where reliability matters more than answer polish"],
    { dataset: TOOL_USE_DATASET, avgScore: 1.33, usable: "6/6", note: "Most reliable model tested — never failed to produce an actionable decision, but scored low on answer quality." }
  ),
  "@cf/meta/llama-4-scout-17b-16e-instruct": M(
    "@cf/meta/llama-4-scout-17b-16e-instruct", "Llama", "standard", "estimated",
    "17B active / 109B total MoE — larger active parameter count than the 3.3-70B economy tier.",
    ["Long 131K context window"],
    ["Long-document tasks — NOT agent tool-calling, see eval note"],
    { dataset: TOOL_USE_DATASET, avgScore: 0.0, usable: "0/6", note: "Emits tool calls but loops without ever composing an answer — unusable as an agent model on this harness." }
  ),
  "@cf/openai/gpt-oss-120b": M(
    "@cf/openai/gpt-oss-120b", "GPT-OSS", "premium", "estimated",
    "120B parameters — the largest gpt-oss variant on this list.",
    ["Configurable reasoning effort (low/medium/high)", "Large parameter count"],
    ["Deep reasoning tasks — NOT agent tool-calling on this harness, see eval note"],
    { dataset: TOOL_USE_DATASET, avgScore: 0.0, usable: "0/6", note: "Ignored the tool contract outright despite tool_choice:\"required\" — produced zero actionable decisions." }
  ),
  "@cf/openai/gpt-oss-20b": M(
    "@cf/openai/gpt-oss-20b", "GPT-OSS", "economy", "estimated",
    "20B parameters — smallest gpt-oss variant, priced accordingly.",
    ["Configurable reasoning effort (low/medium/high)", "Fast for its class"],
    ["Deep reasoning tasks where tool-calling isn't required"],
    { dataset: TOOL_USE_DATASET, avgScore: 0.0, usable: "0/6", note: "Same tool-contract failure as its 120B sibling — unusable as an agent model on this harness." }
  ),
  "@cf/qwen/qwen3-30b-a3b-fp8": M(
    "@cf/qwen/qwen3-30b-a3b-fp8", "Qwen", "economy", "estimated",
    "30B total / 3B active MoE — small active footprint keeps this cheap.",
    ["Highest per-case score among models that reached an answer at all (2.00)"],
    ["Tasks where occasional non-completion is acceptable"],
    { dataset: TOOL_USE_DATASET, avgScore: 2.0, usable: "4/6", note: "Outscores llama-3.3 on the cases it reaches, but fails the tool contract twice as often — \"sometimes isn't an agent\" is disqualifying for unattended work." }
  ),
  "@cf/mistralai/mistral-small-3.1-24b-instruct": M(
    "@cf/mistralai/mistral-small-3.1-24b-instruct", "Mistral", "economy", "estimated",
    "24B parameters — mid-small class, priced in the economy tier.",
    ["Held the tool contract on 5 of 6 cases"],
    ["General chat and simple agent tasks"],
    { dataset: TOOL_USE_DATASET, avgScore: 0.33, usable: "5/6", note: "Reliable at reaching a decision, low answer quality." }
  ),
  "@cf/ibm-granite/granite-4.0-h-micro": M(
    "@cf/ibm-granite/granite-4.0-h-micro", "Granite", "economy", "estimated",
    "IBM's \"H Micro\" tier — one of the smallest and fastest models tested, priced accordingly.",
    ["By far the BEST answer quality measured on our own eval (3.83/10 vs 2.00 for the next best)", "Small and fast despite the top score — a genuinely surprising result"],
    ["Answer quality matters more than perfect tool-contract adherence"],
    { dataset: TOOL_USE_DATASET, avgScore: 3.83, usable: "5/6", note: "The best model tested on our own harness. Slightly less predictable than llama-3.3 (misses the tool contract once in 6) but wins clearly on quality when it works." }
  ),
  "@cf/google/gemma-4-26b-a4b-it": M(
    "@cf/google/gemma-4-26b-a4b-it", "Gemma", "economy", "estimated",
    "26B total / 4B active MoE — small active footprint, economy tier.",
    ["Long 256K context window"],
    ["Long-context tasks — not yet run through our own agent eval"]
  ),
  "@cf/zai-org/glm-4.7-flash": M(
    "@cf/zai-org/glm-4.7-flash", "GLM", "economy", "estimated",
    "\"Flash\" branding — GLM's own fast/cheap tier.",
    ["Fast, low-cost general chat"],
    ["High-volume simple tasks — not yet run through our own agent eval"]
  ),
  "@cf/zai-org/glm-5.2": M(
    "@cf/zai-org/glm-5.2", "GLM", "premium", "estimated",
    "GLM's flagship model with an extended-reasoning \"max\" mode (up to 85K output tokens) — priced as a premium/flagship tier.",
    ["Configurable reasoning depth (high / max)", "Flagship-class general capability"],
    ["Deep, high-stakes reasoning — not yet run through our own agent eval"]
  ),
  "@cf/nvidia/nemotron-3-120b-a12b": M(
    "@cf/nvidia/nemotron-3-120b-a12b", "Nemotron", "premium", "estimated",
    "120B total / 12B active MoE — large total parameter count, priced as premium.",
    ["Large model class", "256K context window"],
    ["Large-context, high-complexity tasks — not yet run through our own agent eval"]
  ),
  "@cf/moonshotai/kimi-k2.6": M(
    "@cf/moonshotai/kimi-k2.6", "Kimi", "premium", "estimated",
    "Kimi K2 is a very large MoE flagship model family — priced as premium.",
    ["Togglable extended thinking mode", "262K context window"],
    ["Deep reasoning, long-context tasks — not yet run through our own agent eval"]
  ),
  "@cf/moonshotai/kimi-k2.7-code": M(
    "@cf/moonshotai/kimi-k2.7-code", "Kimi", "premium", "estimated",
    "Same large flagship family as K2.6, code-specialized — priced as premium.",
    ["Code-specialized variant of the Kimi K2 family", "262K context window"],
    ["Code-heavy tasks — not yet run through our own agent eval"]
  ),
};

/** Ordering used to rank cost tiers, cheapest first — the axis `effort.ts`'s escalation ceiling
 *  actually walks. Deliberately 3 tiers, not a finer-grained ranking: most of the numbers behind
 *  it are estimates (see costBasis above), and pretending to rank within a tier from an estimate
 *  would be false precision. */
const TIER_RANK: Record<CostTier, number> = { economy: 1, standard: 2, premium: 3 };

/** 1 (cheapest) upward. Ties within a tier are broken by ALLOWED_MODELS order (stable, not
 *  meaningful) — the tier is the real signal, not a fine-grained rank. */
export function costRankForModel(model: string): number {
  const b = MODEL_BENCHMARKS[model as AllowedModel];
  return b ? TIER_RANK[b.costTier] : TIER_RANK.standard;
}

export function benchmarkForModel(model: string): ModelBenchmark | undefined {
  return MODEL_BENCHMARKS[model as AllowedModel];
}

/** Every curated model, cheapest tier first — the order the Discover page and any "what's the
 *  next best model" resolution walk. */
export function listModelBenchmarks(): ModelBenchmark[] {
  return ALLOWED_MODELS.map((m) => MODEL_BENCHMARKS[m]).sort((a, b) => TIER_RANK[a.costTier] - TIER_RANK[b.costTier]);
}

/** Sanity check every curated model has a benchmark entry and every benchmark references a
 *  curated model — a benchmark for a model that fell off ALLOWED_MODELS is a silent trap the same
 *  way a catalogue entry pointing at a dead connector was (connectors/catalogue.ts's own
 *  validator). Throws on drift rather than degrading, since this is build-time-shaped data. */
export function validateModelBenchmarks(): void {
  for (const m of ALLOWED_MODELS) {
    if (!MODEL_BENCHMARKS[m]) throw new Error(`model-benchmarks: no ModelBenchmark entry for allowed model '${m}'`);
  }
  for (const id of Object.keys(MODEL_BENCHMARKS)) {
    if (!(ALLOWED_MODELS as readonly string[]).includes(id)) {
      throw new Error(`model-benchmarks: ModelBenchmark entry '${id}' is not in ALLOWED_MODELS`);
    }
  }
}
