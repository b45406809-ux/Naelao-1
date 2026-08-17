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
  // Google AI Studio (Gemini), reached via the CF AI Gateway compat endpoint with a BYOK Google
  // key (see shared/ai-client.ts's isGoogleAiStudioModel doc) — a genuinely different account/
  // billing relationship from every `@cf/...` entry above, added so a free-tier Google AI Studio
  // key can serve as a real fallback once the account's Workers AI neuron allowance is exhausted.
  //
  // These are deliberately Google's OWN "-latest" aliases, not pinned dated ids, and that was a
  // real, live finding, not a style choice: pinning "gemini-2.5-flash"/"gemini-2.5-flash-lite" and
  // testing them against a real key returned "This model ... is no longer available to new users"
  // (404) — Google had already cut off the ENTIRE 2.5 generation for this key by the time this was
  // wired, with "gemini-2.5-pro" alone still resolving (though free-tier-rate-limited, confirmed by
  // a real 429 rather than a 404 — i.e. genuinely valid, just quota-tight). The "-latest" aliases
  // (gemini-flash-lite-latest / gemini-flash-latest / gemini-pro-latest) are Google's own designed
  // answer to exactly this churn — confirmed live (200 OK) against the same key, alongside several
  // pinned 3.x-generation ids (gemini-3.5-flash, gemini-3.5-flash-lite, gemini-3.6-flash), which
  // is the generation these aliases currently resolve to. 1,048,576 is Google's published context
  // window for the current Gemini 3.x/3.5 generation these aliases resolve to.
  "google-ai-studio/gemini-pro-latest": 1_048_576,
  "google-ai-studio/gemini-flash-latest": 1_048_576,
  "google-ai-studio/gemini-flash-lite-latest": 1_048_576,
  // Pinned free-tier generations — same 1M window as the aliases they sit beside.
  "google-ai-studio/gemini-3.7-flash": 1_048_576,
  "google-ai-studio/gemini-3.6-flash": 1_048_576,
  "google-ai-studio/gemini-3.5-flash": 1_048_576,
  "google-ai-studio/gemini-3.5-flash-lite": 1_048_576,
  // Groq — a THIRD, genuinely independent BYOK provider (same `{provider}/{model}` compat-route
  // convention as Gemini above; "groq/" confirmed as Cloudflare's own literal provider slug for
  // this route via Cloudflare's own AI Gateway docs, not assumed). The concrete reason to add it:
  // Groq's free tier is 14,400 requests/day against Gemini's 20 — the difference between being
  // able to test this platform properly and not, on an account whose shared Workers AI neuron
  // allowance is also capped (see CLAUDE.md's Live Deployment Facts). Every context window below
  // is Groq's own REAL served `context_window` figure, read live from `GET
  // https://api.groq.com/openai/v1/models` against a real key on 2026-08-10 — not the model's
  // upstream nominal figure, matching this file's own llama-3.3-70b-on-Workers-AI precedent of
  // never assuming a hosted window matches what the model family nominally supports.
  //
  // Deliberately excludes `groq/openai/gpt-oss-120b`: dispatched twice, live, through the real
  // deployed reasoning loop, and it failed BOTH times with "attempted to call tool 'json' which
  // was not in request.tools" — independent of reasoning effort (tried low and high) and not a
  // rate-limit (a distinct, clean 429 was observed separately). This is the SAME model family
  // that already failed the tool-calling contract on Workers AI (see model-benchmarks.ts's own
  // "@cf/openai/gpt-oss-120b" eval note — "ignored the tool contract outright") — a second,
  // independent hosting provider reproducing the same failure points at the model family's own
  // harmony/channel response format, not a Groq-specific bug. gpt-oss-20b, hosted on the SAME
  // Groq account, was verified working cleanly — this exclusion is specific to the 120B variant.
  "groq/openai/gpt-oss-20b": 131_072,
  "groq/llama-3.3-70b-versatile": 131_072,
  "groq/llama-3.1-8b-instant": 131_072,
  "groq/qwen/qwen3.6-27b": 131_072,
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
  // Google AI Studio (Gemini) — BYOK, see MODEL_CONTEXT_WINDOWS' own comment above for why these
  // are Google's "-latest" aliases rather than pinned dated ids, and for the live confirmation
  // each one actually resolves on the account's real key.
  "google-ai-studio/gemini-flash-lite-latest",
  "google-ai-studio/gemini-flash-latest",
  "google-ai-studio/gemini-pro-latest",
  // Pinned free-tier generations, added alongside (not instead of) the aliases above. An alias
  // silently moves generation, which is right for "give me the current Flash" but wrong when the
  // point is a SPECIFIC generation — 3.7 Flash's controllable thinking is the reason to pick it,
  // and an alias that later resolves elsewhere would quietly take that away. All four are listed
  // free-of-charge on Google's own pricing page; 3.6/3.5 were additionally confirmed live to
  // resolve on this account's real key. 3.7 is documented-but-not-yet-live-confirmed here, and
  // degrades the same honest way any unreachable model does (a real 404 from the provider).
  // The 2.x generation is deliberately absent: Google cut it off from new-user access.
  "google-ai-studio/gemini-3.7-flash",
  "google-ai-studio/gemini-3.6-flash",
  "google-ai-studio/gemini-3.5-flash",
  "google-ai-studio/gemini-3.5-flash-lite",
  // Groq — see MODEL_CONTEXT_WINDOWS' own comment above for why, and for why gpt-oss-120b is
  // excluded (the only one of the account's real candidates that didn't survive a LIVE dispatched
  // test through the real reasoning loop). The remaining four were each confirmed present and
  // `"active": true` on `GET https://api.groq.com/openai/v1/models` against a real key, declare
  // `"tools"` in `supported_features` (required — the reasoner declares its whole action space as
  // provider tools), AND completed a real `/agent/run` end to end on 2026-08-10. Deliberately
  // excludes `groq/compound`/`groq/compound-mini` (Groq's own built-in agentic systems — no
  // `tools` in their supported_features) and every audio/prompt-guard/tiny-context model on the
  // account (not chat-capable for this platform's use).
  //
  // 2026-08-17: all four were re-probed live through the real reasoning loop and NONE is usable on
  // this account, so offering them means a builder picks a model and gets a product that fails on
  // its first message — the same defect already fixed once for the Claude ids (CLAUDE.md item 72).
  // Removed rather than left in a picker that cannot serve them:
  //   • llama-3.3-70b-versatile, llama-3.1-8b-instant → 404 "model does not exist"; Groq's own docs
  //     no longer list either as a production model.
  //   • openai/gpt-oss-20b, qwen/qwen3.6-27b → 413 "Request too large for model ... in organization"
  //     on every real run: this account's Groq tier allows fewer tokens per minute than one
  //     reasoning payload, so the model exists but can never answer.
  // A business already storing one of these degrades safely — resolveModelConfig re-validates
  // against this list and falls back to DEFAULT_WORKING_MODEL rather than dispatching a dead id.
  // Restore any of them the moment a live probe passes again; each is one line.
] as const;

export type AllowedModel = (typeof ALLOWED_MODELS)[number];

/** Whether a model string is one a builder may select / a run may name. */
export function isAllowedModel(model: string): model is AllowedModel {
  return (ALLOWED_MODELS as readonly string[]).includes(model);
}

/**
 * "Did you mean" ranking for a model id an agent typed that isn't in ALLOWED_MODELS. A weak model
 * that guesses `gemini-flash` or `llama-70b` or `gpt-oss` (a partial / stale / provider-prefix-less
 * id) should get pointed at the closest real ids rather than a bare 404. Ranks every allowed model
 * against the guess by token overlap over the id's own segments (split on `/`, `-`, `.`, `@`),
 * with a substring bonus, and returns the best few. Deterministic and dependency-free — matches
 * the same "structure over a fuzzy library" posture as tool-surface's suggestOperations.
 */
export function suggestModels(guess: string, max = 3): AllowedModel[] {
  const g = guess.toLowerCase().trim();
  if (!g) return [];
  const gTokens = new Set(g.split(/[/\-.@\s]+/).filter(Boolean));
  const scored = ALLOWED_MODELS.map((m) => {
    const ml = m.toLowerCase();
    const mTokens = ml.split(/[/\-.@\s]+/).filter(Boolean);
    let score = 0;
    for (const t of mTokens) if (gTokens.has(t)) score += 2;
    // Substring in either direction (e.g. guess "llama-70b" ⊂ "llama-3.3-70b-...").
    if (ml.includes(g) || g.includes(ml)) score += 3;
    // A shared distinctive segment (a family/vendor token appearing in both) is a strong signal.
    for (const t of gTokens) if (t.length >= 3 && ml.includes(t)) score += 1;
    return { m, score };
  })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map((s) => s.m);
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
  // Google AI Studio (Gemini). Confirmed via Google's own OpenAI-compatibility docs: the
  // OpenAI-shaped `reasoning_effort` field is accepted directly and maps internally onto Gemini's
  // native `thinking_budget` (none→0, low→1024, medium→8192, high→24576) — the SAME
  // "reasoning_effort" wire shape gpt-oss/glm-5.2 already use above, so no new ReasoningParamShape
  // is needed. Flash and Flash-Lite can fully disable thinking ("none"); Pro cannot — Google's own
  // docs state reasoning cannot be turned off for Pro (or the 3-series generally), so its ladder
  // starts at "low" rather than "none".
  "google-ai-studio/gemini-flash-lite-latest": { reasoningLevels: ["none", "low", "medium", "high"], reasoningParam: "reasoning_effort" },
  "google-ai-studio/gemini-flash-latest": { reasoningLevels: ["none", "low", "medium", "high"], reasoningParam: "reasoning_effort" },
  "google-ai-studio/gemini-pro-latest": { reasoningLevels: ["low", "medium", "high"], reasoningParam: "reasoning_effort" },
  // 3.7 Flash's controllable thinking is the whole reason to pin it rather than ride an alias:
  // plain Flash stalls on multi-step tool use, and a configurable thinking budget is what Effort
  // maps onto (nativeReasoningForEffort). Same four-position ladder as the Flash alias.
  "google-ai-studio/gemini-3.7-flash": { reasoningLevels: ["none", "low", "medium", "high"], reasoningParam: "reasoning_effort" },
  "google-ai-studio/gemini-3.6-flash": { reasoningLevels: ["none", "low", "medium", "high"], reasoningParam: "reasoning_effort" },
  "google-ai-studio/gemini-3.5-flash": { reasoningLevels: ["none", "low", "medium", "high"], reasoningParam: "reasoning_effort" },
  "google-ai-studio/gemini-3.5-flash-lite": { reasoningLevels: ["none", "low", "medium", "high"], reasoningParam: "reasoning_effort" },
  // Groq. Confirmed via Groq's own docs (console.groq.com/docs/reasoning), not inferred from the
  // Workers AI entries above even though this is the SAME underlying model — Groq is a different
  // hosting provider and could in principle expose a different parameter surface; it happens to
  // use the identical "reasoning_effort" field name and low/medium/high values gpt-oss already
  // uses elsewhere in this table, confirmed independently for the Groq-hosted copy. (gpt-oss-120b
  // is NOT offered on Groq — see models.ts's own ALLOWED_MODELS comment for the live failure that
  // excluded it; tried both "low" and "high" here and neither fixed it.)
  "groq/openai/gpt-oss-20b": { reasoningLevels: ["low", "medium", "high"], reasoningParam: "reasoning_effort" },
  // Llama on Groq has no configurable reasoning mode (it isn't a reasoning-trained model at all —
  // same as its Workers AI sibling above).
  "groq/llama-3.3-70b-versatile": NO_REASONING,
  "groq/llama-3.1-8b-instant": NO_REASONING,
  // Qwen 3.6 27B on Groq: confirmed via Groq's own docs — a 2-level toggle, "none" (disable
  // reasoning) or "default" (let Qwen reason), NOT the low/medium/high shape gpt-oss uses. Reuses
  // "reasoning_effort" as the wire param name (Groq's own field for this model too) — only the
  // VALUES differ from gpt-oss, which effort.ts's generic ladder-length logic already handles
  // (a 2-native-level model gets a 3-position Effort ladder, saturating at its own top for "high").
  "groq/qwen/qwen3.6-27b": { reasoningLevels: ["none", "default"], reasoningParam: "reasoning_effort" },
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
