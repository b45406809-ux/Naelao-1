import test from "node:test";
import assert from "node:assert/strict";
import { CASES, DEFAULT_GROQ_EVAL_MODEL, parseKeys, runProviderEvaluation, safeCredentialSummary, safeProviderMetrics } from "./swarm-provider-eval.mjs";

function expectedDecisionFromRequest(init) {
  const request = JSON.parse(init.body);
  const prompt = request.contents?.[0]?.parts?.[0]?.text ?? request.messages?.[0]?.content ?? "";
  const testCase = CASES.find(item => prompt.includes(`\"id\":\"${item.id}\"`));
  return testCase?.expected ?? "review";
}

test("advanced decision fixture covers provenance, injection, conflicts and judgment cases", () => {
  assert.equal(CASES.length, 8);
  assert.equal(CASES.filter(item => item.expected === "pass").length, 3);
  assert.equal(CASES.filter(item => item.expected === "review").length, 5);
  assert.ok(CASES.some(item => item.category === "prompt-injection"));
  assert.equal(DEFAULT_GROQ_EVAL_MODEL, "openai/gpt-oss-20b");
});

test("secret parser deduplicates keys and reports only anonymized slot counts", () => {
  assert.deepEqual(parseKeys("alpha, beta,alpha"), ["alpha", "beta"]);
  assert.throws(() => parseKeys(Array(17).fill("x").join(",")), /provider_key_configuration_invalid/);
  const summary = safeCredentialSummary({ GEMINI_API_KEYS: "secret-one,secret-two", GROQ_API_KEY: "private" });
  assert.deepEqual(summary, { gemini: { configured: true, slots: 2 }, groqcloud: { configured: true, slots: 1 } });
  assert.equal(JSON.stringify(summary).includes("secret"), false);
});

test("provider evaluation blocks missing free-tier approval without making network calls", async () => {
  let calls = 0;
  const result = await runProviderEvaluation({ env: { GEMINI_API_KEYS: "private", RUN_GEMINI_FREE_EVAL: "true" }, fetcher: async () => { calls++; throw new Error("must not call"); } });
  assert.equal(calls, 0);
  assert.equal(result.results[0].state, "blocked");
  assert.equal(result.results[0].reason, "free_tier_not_confirmed");
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("provider comparison uses only verified models and stops on quota without rotating keys", async () => {
  let inferenceCalls = 0;
  const fetcher = async (url, init) => {
    if (String(url).endsWith("/v1beta/models")) return Response.json({ models: [{ name: "models/gemini-3.5-flash-lite", supportedGenerationMethods: ["generateContent"] }] });
    if (inferenceCalls++ === 0) return new Response("", { status: 429, headers: { "retry-after": "1" } });
    throw new Error("quota responses must not retry or rotate");
  };
  const result = await runProviderEvaluation({ env: { GEMINI_API_KEYS: "one,two", RUN_GEMINI_FREE_EVAL: "true", GEMINI_FREE_TIER_CONFIRMED: "true" }, fetcher });
  assert.equal(inferenceCalls, 1);
  assert.equal(result.results[0].requests, 2);
  assert.equal(result.results[0].inferenceRequests, 1);
  assert.equal(result.results[0].state, "blocked");
  assert.equal(result.results[0].reason, "quota_or_rate_limited; no rotation or retry attempted");
  assert.equal(result.results[0].cases[0].keySlot, 1);
});

test("provider response contents and credential slots do not leak into errors or reports", async () => {
  const fetcher = async (url, init = {}) => {
    if (String(url).endsWith("/v1beta/models")) return Response.json({ models: [{ name: "models/gemini-3.5-flash-lite", supportedGenerationMethods: ["generateContent"] }] });
    const choice = expectedDecisionFromRequest(init);
    const body = JSON.parse(init.body);
    assert.equal(body.generationConfig.responseMimeType, "application/json");
    const prompt = body.contents[0].parts[0].text;
    const text = prompt.includes("unsupported-criterion") ? "not-json" : JSON.stringify({ decision: choice });
    return Response.json({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4 }, ignoredProviderMetadata: "private-response" });
  };
  const result = await runProviderEvaluation({ env: { GEMINI_API_KEY: "secret-key", RUN_GEMINI_FREE_EVAL: "true", GEMINI_FREE_TIER_CONFIRMED: "true" }, fetcher });
  assert.equal(result.results[0].requests, 9);
  assert.equal(result.results[0].modelCheckRequests, 1);
  assert.equal(result.results[0].inferenceRequests, 8);
  assert.equal(result.results[0].cases[0].decision, "pass");
  assert.equal(result.results[0].state, "partial");
  assert.equal(result.results[0].qualityOutcome, "errors_or_invalid_responses");
  assert.equal(result.results[0].validResponseRate, 7 / 8);
  assert.equal(result.results[0].accuracy, 1);
  assert.equal(result.results[0].strictAccuracy, 7 / 8);
  assert.equal(result.results[0].falseAcceptance, 0);
  assert.equal(result.results[0].confusionMatrix.invalidResponses, 1);
  assert.equal(result.results[0].categoryMetrics.length, 8);
  assert.equal(JSON.stringify(result).includes("secret-key"), false);
  assert.equal(JSON.stringify(result).includes("private-response"), false);
  assert.equal(JSON.stringify(safeProviderMetrics(result.results[0])).includes("private-response"), false);
  assert.equal(JSON.stringify(safeProviderMetrics(result.results[0])).includes("not-json"), false);
});

test("provider diagnostics preserve only allowlisted case metrics and HTTP status", async () => {
  const fetcher = async (url) => {
    if (String(url).endsWith("/v1beta/models")) return Response.json({ models: [{ name: "models/gemini-3.5-flash-lite", supportedGenerationMethods: ["generateContent"] }] });
    return new Response(JSON.stringify({ error: { message: "private provider detail" } }), { status: 400 });
  };
  const result = await runProviderEvaluation({ env: { GEMINI_API_KEY: "private-key", RUN_GEMINI_FREE_EVAL: "true", GEMINI_FREE_TIER_CONFIRMED: "true" }, fetcher });
  const safe = safeProviderMetrics(result.results[0]);
  assert.equal(safe.cases[0].failure, "provider_error");
  assert.equal(safe.cases[0].httpStatus, 400);
  assert.equal(Object.hasOwn(safe.cases[0], "prompt"), false);
  assert.equal(Object.hasOwn(safe.cases[0], "response"), false);
  assert.equal(JSON.stringify(safe).includes("private provider detail"), false);
  assert.equal(JSON.stringify(safe).includes("private-key"), false);
});

test("complete evaluation reports strict quality, confusion counts and latency separately from transport completion", async () => {
  const fetcher = async (url, init = {}) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "openai/gpt-oss-20b" }] });
    const choice = expectedDecisionFromRequest(init);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ decision: choice }) } }], usage: { prompt_tokens: 22, completion_tokens: 4 } });
  };
  const result = await runProviderEvaluation({ env: { GROQ_API_KEY: "secret", GROQ_FREE_MODEL_ID: DEFAULT_GROQ_EVAL_MODEL, RUN_GROQ_FREE_EVAL: "true", GROQ_FREE_TIER_CONFIRMED: "true" }, fetcher });
  const measured = result.results[1];
  assert.equal(measured.state, "completed");
  assert.equal(measured.qualityOutcome, "all_cases_correct");
  assert.equal(measured.modelCheckRequests, 1);
  assert.equal(measured.inferenceRequests, CASES.length);
  assert.equal(measured.requests, CASES.length + 1);
  assert.equal(measured.validResponseRate, 1);
  assert.equal(measured.accuracy, 1);
  assert.equal(measured.strictAccuracy, 1);
  assert.equal(measured.falseAcceptance, 0);
  assert.deepEqual(measured.confusionMatrix, { truePass: 3, falseAcceptance: 0, trueReview: 5, falseRejection: 0, invalidResponses: 0 });
  assert.equal(measured.inputTokens, 22 * CASES.length);
  assert.equal(measured.outputTokens, 4 * CASES.length);
  assert.equal(measured.nominalPaidCost.estimatedUsd, 0.0000228);
  assert.equal(measured.nominalPaidCost.estimatedUsdPer1000Cases, 0.00285);
  assert.equal(measured.nominalPaidCost.pricingSnapshotDate, "2026-10-31");
  assert.equal(measured.categoryMetrics.length, CASES.length);
  assert.ok(Number.isFinite(measured.latencyP50Ms));
  assert.ok(Number.isFinite(measured.latencyP95Ms));
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("GroqCloud uses its own API endpoint and rotates only after access denial", async () => {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url: String(url), authorization: init.headers?.authorization });
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "org-approved-free-model" }] });
    if (init.headers?.authorization === "Bearer key-one") return new Response("", { status: 401 });
    const choice = expectedDecisionFromRequest(init);
    const request = JSON.parse(init.body);
    assert.equal(request.max_completion_tokens, 128);
    assert.equal(request.reasoning_effort, "low");
    assert.equal(Object.hasOwn(request, "max_tokens"), false);
    assert.deepEqual(request.response_format, { type: "json_object" });
    return Response.json({ choices: [{ message: { content: JSON.stringify({ decision: choice }) } }], usage: { prompt_tokens: 10, completion_tokens: 4 } });
  };
  const result = await runProviderEvaluation({ env: { GROQ_API_KEYS: "key-one,key-two", GROQ_FREE_MODEL_ID: "org-approved-free-model", RUN_GROQ_FREE_EVAL: "true", GROQ_FREE_TIER_CONFIRMED: "true" }, fetcher });
  assert.ok(calls.every(call => call.url.startsWith("https://api.groq.com/openai/v1/")));
  assert.equal(result.results[1].inferenceRequests, 8);
  assert.equal(result.results[1].requests, 9);
  assert.equal(result.results[1].state, "partial");
  assert.equal(result.results[1].cases.filter(item => item.state === "completed").length, 7);
  assert.equal(result.results[1].cases[0].keySlot, 2);
  assert.equal(JSON.stringify(result).includes("key-one"), false);
  assert.equal(JSON.stringify(result).includes("key-two"), false);
});
