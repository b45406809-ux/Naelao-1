import test from "node:test";
import assert from "node:assert/strict";
import { buildRequest, runSmoke, validateResponse } from "./verify-system-one.mjs";

test("builds the typed Jev/Laya choice request", () => {
  assert.deepEqual(buildRequest("test-model").questions.decision.criteria, { SAFE: null, UNSAFE: null });
});

test("validates a typed provider response and reports latency", async () => {
  const result = await runSmoke({
    endpoint: "http://laya.test/v1/systemone",
    fetcher: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.questions.decision.type, "choice");
      return new Response(JSON.stringify({
        model: "jev-test",
        answers: { decision: { type: "choice", choice: "SAFE", confidence: 0.99, probabilities: { SAFE: 0.99, UNSAFE: 0.01 } } },
        usage: { input_tokens: 3, output_tokens: 0 },
      }), { status: 200 });
    },
  });
  assert.equal(result.provider, "laya");
  assert.equal(result.choice, "SAFE");
  assert.equal(result.usage.output_tokens, 0);
});

test("rejects malformed provider output", () => {
  assert.throws(() => validateResponse({ model: "jev", answers: { decision: { type: "choice", choice: "MAYBE" } } }), /system_one_invalid_choice/);
});
