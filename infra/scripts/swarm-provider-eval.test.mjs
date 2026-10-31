import test from "node:test";
import assert from "node:assert/strict";
import { parseKeys, runProviderEvaluation, safeCredentialSummary } from "./swarm-provider-eval.mjs";

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
  const fetcher = async (url) => {
    if (String(url).endsWith("/v1beta/models")) return Response.json({ models: [{ name: "models/gemini-3.5-flash-lite", supportedGenerationMethods: ["generateContent"] }] });
    return Response.json({ candidates: [{ content: { parts: [{ text: "{\"decision\":\"pass\"}" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4 }, ignoredProviderMetadata: "private-response" });
  };
  const result = await runProviderEvaluation({ env: { GEMINI_API_KEY: "secret-key", RUN_GEMINI_FREE_EVAL: "true", GEMINI_FREE_TIER_CONFIRMED: "true" }, fetcher });
  assert.equal(result.results[0].requests, 5);
  assert.equal(result.results[0].inferenceRequests, 4);
  assert.equal(result.results[0].cases[0].decision, "pass");
  assert.equal(JSON.stringify(result).includes("secret-key"), false);
  assert.equal(JSON.stringify(result).includes("private-response"), false);
});

test("GroqCloud uses its own API endpoint and rotates only after access denial", async () => {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url: String(url), authorization: init.headers?.authorization });
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "org-approved-free-model" }] });
    if (init.headers?.authorization === "Bearer key-one") return new Response("", { status: 401 });
    return Response.json({ choices: [{ message: { content: "{\"decision\":\"review\"}" } }], usage: { prompt_tokens: 10, completion_tokens: 4 } });
  };
  const result = await runProviderEvaluation({ env: { GROQ_API_KEYS: "key-one,key-two", GROQ_FREE_MODEL_ID: "org-approved-free-model", RUN_GROQ_FREE_EVAL: "true", GROQ_FREE_TIER_CONFIRMED: "true" }, fetcher });
  assert.ok(calls.every(call => call.url.startsWith("https://api.groq.com/openai/v1/")));
  assert.equal(result.results[1].inferenceRequests, 5);
  assert.equal(result.results[1].requests, 6);
  assert.equal(result.results[1].cases[0].keySlot, 2);
  assert.equal(JSON.stringify(result).includes("key-one"), false);
  assert.equal(JSON.stringify(result).includes("key-two"), false);
});
