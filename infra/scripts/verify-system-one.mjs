import { performance } from "node:perf_hooks";

const DEFAULT_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
const DEFAULT_MODEL = "cloudflare/clef-flash";
const LONG_CONTEXT_MODEL = "perplexity/pplx-decider-v1.2";

export function resolveSmokeModel(model) {
  if (model === "jev-latest" || /^jev-[0-9]/.test(model) || model === "laya-typed-decisions") return DEFAULT_MODEL;
  if (["clef", "@cf/cloudflare/clef", "cloudflare/clef", "clef-flash", "@cf/cloudflare/clef-flash", "perplexity/pplx-decider-flash-v1.2", DEFAULT_MODEL].includes(model)) return DEFAULT_MODEL;
  if (model === LONG_CONTEXT_MODEL) return DEFAULT_MODEL;
  throw new Error("system_one_unsupported_openrouter_model");
}

export function buildRequest(model = DEFAULT_MODEL) {
  return {
    model,
    state: { naelao_smoke_test: true, request: "return the safer decision" },
    questions: {
      decision: {
        type: "choice",
        instructions: "Choose the safer option. Return only the typed decision object.",
        criteria: { SAFE: null, UNSAFE: null },
      },
    },
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateResponse(payload) {
  assert(payload && typeof payload === "object", "system_one_invalid_response");
  assert(typeof payload.model === "string" && payload.model.length > 0, "system_one_missing_model");
  const answer = payload.answers?.decision;
  assert(answer?.type === "choice", "system_one_missing_choice_answer");
  assert(answer.choice === "SAFE" || answer.choice === "UNSAFE", "system_one_invalid_choice");
  assert(Number.isFinite(answer.confidence) && answer.confidence >= 0 && answer.confidence <= 1, "system_one_invalid_confidence");
  const probabilities = answer.probabilities;
  assert(probabilities && typeof probabilities === "object", "system_one_missing_probabilities");
  assert(Number.isFinite(probabilities.SAFE) && Number.isFinite(probabilities.UNSAFE), "system_one_invalid_probabilities");
  assert(Math.abs(probabilities.SAFE + probabilities.UNSAFE - 1) <= 0.02, "system_one_invalid_probability_sum");
  assert(Number.isSafeInteger(payload.usage?.input_tokens) && Number.isSafeInteger(payload.usage?.output_tokens), "system_one_invalid_usage");
  return { model: payload.model, choice: answer.choice, confidence: answer.confidence, usage: payload.usage };
}

export async function runSmoke({ apiKey = process.env.OPENROUTER_API_KEY, model = resolveSmokeModel(process.env.SYSTEM_ONE_MODEL || DEFAULT_MODEL), fetcher = globalThis.fetch } = {}) {
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required for OpenRouter Decisions API");
  const selectedModel = resolveSmokeModel(model);
  const started = performance.now();
  const response = await fetcher(DEFAULT_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify(buildRequest(selectedModel)),
  });
  if (!response.ok) throw new Error(`system_one_http_${response.status}:${(await response.text()).slice(0, 200)}`);
  const result = validateResponse(await response.json());
  return { endpoint: DEFAULT_ENDPOINT, provider: "openrouter", latencyMs: Math.round(performance.now() - started), ...result };
}

if (process.argv[1]?.endsWith("verify-system-one.mjs")) {
  try {
    console.log(JSON.stringify(await runSmoke(), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ passed: false, error: String(error.message ?? error) }, null, 2));
    process.exitCode = 1;
  }
}
