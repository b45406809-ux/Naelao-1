/**
 * The curated model list, context windows, and reasoning-capability table — a dependency-free
 * leaf module. Deliberately split out of index.ts: model-benchmarks.ts and effort.ts both need
 * these primitives, and index.ts re-exports model-benchmarks.ts/effort.ts back out — importing
 * from index.ts directly would make that a genuine circular module dependency. ESM circular
 * imports CAN work via live bindings, but esbuild's bundling (used by `wrangler deploy`) resolved
 * the cycle differently than the local tsc/vitest build did, so a top-level
 * `Math.max(...ALLOWED_MODELS.map(...))` in effort.ts saw `ALLOWED_MODELS` as `undefined` at
 * deploy time even though every local test passed — a real, deploy-only failure caught by an
 * actual `wrangler deploy`, not by the test suite. Everything here has zero imports of its own,
 * so nothing that imports it can ever be part of a cycle.
 */

/**
 * §A1.27: per-model context window size, in tokens — replaces the single hardcoded
 * `MODEL_CONTEXT_LIMIT_TOKENS = 190_000` figure previously baked into `NaelaoAgentDO.ts` (tagged
 * to Sonnet specifically, so it was already wrong for any other model even before the model
 * switcher makes model choice real). Verify against current model documentation before relying on
 * this for a hard cutoff — these are the platform's own approximate defaults, kept next to
 * computeTokenCostMicro's per-model pricing table since both vary per model and should stay
 * mutually consistent (same set of known model strings).
 */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5-20251001": 200_000,
  "claude-opus-4-8": 200_000,
  // CF Workers AI — every window below is the model's REAL served window, read from the account's
  // own /ai/models/search API rather than the model's nominal upstream figure. Llama 3.3 is the
  // clearest reason not to assume: Workers AI serves it at 24k against a native 128k. Context
  // accounting and the shell's context meter must never treat these as interchangeable.
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": 24_000,
  "@cf/qwen/qwen3-30b-a3b-fp8": 32_768,
  "@cf/openai/gpt-oss-120b": 128_000,
  "@cf/openai/gpt-oss-20b": 128_000,
  "@cf/mistralai/mistral-small-3.1-24b-instruct": 128_000,
  "@cf/ibm-granite/granite-4.0-h-micro": 131_000,
  "@cf/meta/llama-4-scout-17b-16e-instruct": 131_000,
  "@cf/zai-org/glm-4.7-flash": 131_072,
  "@cf/nvidia/nemotron-3-120b-a12b": 256_000,
  "@cf/google/gemma-4-26b-a4b-it": 256_000,
  "@cf/zai-org/glm-5.2": 262_144,
  "@cf/moonshotai/kimi-k2.6": 262_144,
  "@cf/moonshotai/kimi-k2.7-code": 262_144,
};

/**
 * The models a builder may select, and the ONLY models an eval or a run may name.
 *
 * Two properties are load-bearing and both were verified against the account's live
 * /ai/models/search rather than assumed:
 *  - every `@cf/...` entry advertises `function_calling: true`. The reasoner's entire action
 *    space is declared as provider tools (script-engine/reasoner.ts), so a model without tool
 *    calling degrades to the prose-JSON fallback and is materially less reliable — it does not
 *    belong on a list a builder can pick from.
 *  - the list is CURATED, not free text: cost has to stay predictable, and every entry needs a
 *    real context window above for accounting to work.
 *
 * Claude ids are retained for accounts whose AI Gateway actually has Anthropic wired; on an
 * account without it (which is the case today — see CLAUDE.md item 68) they simply never resolve,
 * and the Workers AI entries are the real choice set.
 */
export const ALLOWED_MODELS = [
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6",
  "claude-opus-4-8",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-4-scout-17b-16e-instruct",
  "@cf/openai/gpt-oss-120b",
  "@cf/openai/gpt-oss-20b",
  "@cf/qwen/qwen3-30b-a3b-fp8",
  "@cf/mistralai/mistral-small-3.1-24b-instruct",
  "@cf/ibm-granite/granite-4.0-h-micro",
  "@cf/google/gemma-4-26b-a4b-it",
  "@cf/zai-org/glm-4.7-flash",
  "@cf/zai-org/glm-5.2",
  "@cf/nvidia/nemotron-3-120b-a12b",
  "@cf/moonshotai/kimi-k2.6",
  "@cf/moonshotai/kimi-k2.7-code",
] as const;

export type AllowedModel = (typeof ALLOWED_MODELS)[number];

/** Whether a model string is one a builder may select / a run may name. */
export function isAllowedModel(model: string): model is AllowedModel {
  return (ALLOWED_MODELS as readonly string[]).includes(model);
}

/**
 * The model a run falls back to when neither an explicit request nor a product's own
 * `productConfig.modelConfig.model` names one. This used to be a bare `"claude-sonnet-4-6"`
 * literal at each fallback site — on an account whose AI Gateway has no Anthropic provider wired
 * (see CLAUDE.md item 68 — Workers AI only, confirmed live), that string 404s with "Model not
 * found" on every single unconfigured product. A Claude id is only a safe default on a deployment
 * that actually has Anthropic behind its gateway; a Workers AI id is the one guaranteed to resolve
 * everywhere, so it is the shared default rather than a Claude one. Matches the dashboard's own
 * model-picker default (apps/dashboard's Configuration tab) — both must name the same model or a
 * builder who never opens Configuration gets a different default than the one shown as selected.
 */
export const DEFAULT_WORKING_MODEL: AllowedModel = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Context window size for a model, falling back to a documented default for an unknown model
 *  string rather than throwing — a model-switcher allowlist entry that outpaces this table
 *  should degrade to a sane default, not break context accounting. */
export function contextWindowForModel(model: string): number {
  return MODEL_CONTEXT_WINDOWS[model] ?? DEFAULT_CONTEXT_WINDOW;
}

/**
 * How a chosen reasoning-effort LEVEL gets sent to Cloudflare's AI REST API — the models on this
 * list don't all share one wire shape:
 *  - "reasoning_effort": a plain `reasoning_effort: "<level>"` field at the top level of the
 *    request body. Confirmed present on glm-5.2's own Workers AI docs page (described generically
 *    as "constrains effort on reasoning for reasoning models") and reported for gpt-oss-120b/20b
 *    (OpenAI's own Responses-API-style "low"/"medium"/"high").
 *  - "kimi_thinking": Moonshot's Kimi K2.6 family uses ITS OWN shape instead — a boolean
 *    `chat_template_kwargs: { thinking: true|false }` field, and returns the model's reasoning
 *    text in a `reasoning` response field rather than the more common `reasoning_content` name
 *    (Cloudflare's own Kimi K2.6 changelog post names both differences explicitly).
 *  - "none": no configurable reasoning mode.
 */
export type ReasoningParamShape = "reasoning_effort" | "kimi_thinking" | "none";

export interface ModelCapability {
  /** Ordered low → high. Empty when the model has no configurable reasoning at all. A model with
   *  a plain on/off toggle (no graduated effort) reports exactly two levels, e.g. ["off", "on"]. */
  reasoningLevels: readonly string[];
  reasoningParam: ReasoningParamShape;
}

const NO_REASONING: ModelCapability = { reasoningLevels: [], reasoningParam: "none" };

/**
 * Per-model reasoning/"thinking" capability for every entry in ALLOWED_MODELS — what a model
 * switcher's capability-aware config card should offer, and how to wire a chosen level into the
 * actual AI Gateway request (ai-client.ts's buildUniversalBody).
 *
 * Confirmed against each model's own Cloudflare Workers AI docs page or changelog post where
 * noted below; NOT yet exercised against a LIVE call for any entry except the account's actual
 * working default (llama-3.3-70b, correctly NO_REASONING — it isn't a reasoning model) — this
 * account has only ever successfully served that one model in production (CLAUDE.md item 68).
 * Confirm the exact wire shape the first time a reasoning-capable model here actually gets called,
 * same "confirm once real access exists" precedent as this codebase's Whop/Composio/Pipedream
 * integrations. Entries with no independently confirmed reasoning shape default to NO_REASONING
 * rather than guessing — a missing config control is a UI gap, a wrong one silently mis-bills or
 * 400s a real request.
 */
export const MODEL_CAPABILITIES: Record<string, ModelCapability> = {
  "claude-haiku-4-5-20251001": NO_REASONING,
  "claude-sonnet-4-6": NO_REASONING,
  "claude-opus-4-8": NO_REASONING,
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": NO_REASONING,
  "@cf/meta/llama-4-scout-17b-16e-instruct": NO_REASONING,
  // Confirmed: OpenAI's own gpt-oss docs describe "reasoning_effort" (low/medium/high) as a
  // first-class, fully documented Responses-API parameter; Cloudflare's changelog post announcing
  // these models on Workers AI names "adjustable reasoning effort levels" explicitly.
  "@cf/openai/gpt-oss-120b": { reasoningLevels: ["low", "medium", "high"], reasoningParam: "reasoning_effort" },
  "@cf/openai/gpt-oss-20b": { reasoningLevels: ["low", "medium", "high"], reasoningParam: "reasoning_effort" },
  "@cf/qwen/qwen3-30b-a3b-fp8": NO_REASONING,
  "@cf/mistralai/mistral-small-3.1-24b-instruct": NO_REASONING,
  "@cf/ibm-granite/granite-4.0-h-micro": NO_REASONING,
  "@cf/google/gemma-4-26b-a4b-it": NO_REASONING,
  "@cf/zai-org/glm-4.7-flash": NO_REASONING,
  // Confirmed via glm-5.2's own Workers AI docs page (reasoning_effort field present in its
  // parameter list) plus third-party coverage describing exactly two named modes: "High" (default,
  // faster, ~half the output tokens) and "Max" (extended chain-of-thought, up to 85K output
  // tokens, +30-80% first-token latency).
  "@cf/zai-org/glm-5.2": { reasoningLevels: ["high", "max"], reasoningParam: "reasoning_effort" },
  "@cf/nvidia/nemotron-3-120b-a12b": NO_REASONING,
  // Confirmed: Kimi K2.6 uses chat_template_kwargs.thinking (a boolean) rather than
  // reasoning_effort, and returns its chain-of-thought under a `reasoning` response field instead
  // of the more common `reasoning_content` name — both are called out explicitly in Cloudflare's
  // own K2.6 model docs. K2.7-code is the same model family's code-specialized variant; treated
  // the same pending independent confirmation of its own docs page.
  "@cf/moonshotai/kimi-k2.6": { reasoningLevels: ["off", "on"], reasoningParam: "kimi_thinking" },
  "@cf/moonshotai/kimi-k2.7-code": { reasoningLevels: ["off", "on"], reasoningParam: "kimi_thinking" },
};

/** Reasoning capability for a model string, degrading to NO_REASONING for anything not in the
 *  table above rather than throwing — an unknown/future model should just show no reasoning
 *  control, not break the config card. */
export function capabilityForModel(model: string): ModelCapability {
  return MODEL_CAPABILITIES[model] ?? NO_REASONING;
}

/** Whether `level` is one this model actually offers — used to validate a client-supplied
 *  reasoning-effort override server-side before it ever reaches the AI Gateway request. */
export function isValidReasoningLevel(model: string, level: string): boolean {
  return capabilityForModel(model).reasoningLevels.includes(level);
}
