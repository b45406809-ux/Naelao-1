import { performance } from "node:perf_hooks";

const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

export function buildRequest(model = "jev-latest") {
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

export async function runSmoke({ endpoint = process.env.SYSTEM_ONE_ENDPOINT || DEFAULT_ENDPOINT, apiKey = process.env.TYPESAFE_API_KEY, model = process.env.SYSTEM_ONE_MODEL || "jev-latest", fetcher = globalThis.fetch } = {}) {
  if (!endpoint) throw new Error("SYSTEM_ONE_ENDPOINT is required");
  if (endpoint === DEFAULT_ENDPOINT && !apiKey) throw new Error("TYPESAFE_API_KEY is required for the hosted Jev endpoint");
  const started = performance.now();
  const response = await fetcher(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify(buildRequest(model)),
  });
  if (!response.ok) throw new Error(`system_one_http_${response.status}:${(await response.text()).slice(0, 200)}`);
  const result = validateResponse(await response.json());
  return { endpoint, provider: endpoint === DEFAULT_ENDPOINT ? "jev" : "laya", latencyMs: Math.round(performance.now() - started), ...result };
}

if (process.argv[1]?.endsWith("verify-system-one.mjs")) {
  try {
    console.log(JSON.stringify(await runSmoke(), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ passed: false, error: String(error.message ?? error) }, null, 2));
    process.exitCode = 1;
  }
}
