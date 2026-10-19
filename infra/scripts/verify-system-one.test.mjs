import test from "node:test";
import assert from "node:assert/strict";
import { buildRequest, resolveSmokeModel, runSmoke, validateResponse } from "./verify-system-one.mjs";

test("builds a Decider request for the OpenRouter Decisions API", () => {
  assert.equal(buildRequest().model, "perplexity/pplx-decider-v1.2");
  assert.deepEqual(buildRequest().questions.decision.criteria, { SAFE: null, UNSAFE: null });
  assert.equal(resolveSmokeModel("@cf/cloudflare/clef-flash"), "perplexity/pplx-decider-flash-v1.2");
  assert.equal(resolveSmokeModel("jev-latest"), "perplexity/pplx-decider-v1.2");
});

test("validates an OpenRouter decision response and reports latency", async () => {
  const result = await runSmoke({
    apiKey: "secret",
    fetcher: async (url, init) => {
      assert.equal(url, "https://openrouter.ai/api/alpha/decisions");
      const body = JSON.parse(init.body);
      assert.equal(body.model, "perplexity/pplx-decider-v1.2");
      assert.equal(body.questions.decision.type, "choice");
      return new Response(JSON.stringify({
        model: "perplexity/pplx-decider-v1.2",
        answers: { decision: { type: "choice", choice: "SAFE", confidence: 0.99, probabilities: { SAFE: 0.99, UNSAFE: 0.01 } } },
        usage: { input_tokens: 3, output_tokens: 0 },
      }), { status: 200 });
    },
  });
  assert.equal(result.provider, "openrouter");
  assert.equal(result.choice, "SAFE");
  assert.equal(result.usage.output_tokens, 0);
});

test("rejects malformed provider output", () => {
  assert.throws(() => validateResponse({ model: "perplexity/pplx-decider-v1.2", answers: { decision: { type: "choice", choice: "MAYBE" } } }), /system_one_invalid_choice/);
});
