import assert from "node:assert/strict";
import test from "node:test";
import { fetchRuntimeEconomics } from "./capture-runtime-economics.mjs";

const metrics = {
  periodDays: 30,
  sampleCount: 10_001,
  tierCounts: { "1": 9_700, "2": 200, "3": 50, "4": 20, "5": 20, "6": 11 },
  tierOneTwoShare: 0.9899,
  tierSixShare: 0.0011,
  successRate: 0.999,
  averageDurationMs: 2.1,
  p50DurationMs: 1,
  p95DurationMs: 4.5,
  tierOneTwoP95DurationMs: 4.2,
  totalTokens: 123,
};

test("captures and validates the production endpoint schema", async () => {
  let requested;
  const result = await fetchRuntimeEconomics({
    endpoint: "https://naelao.example/v1/analytics/runtime-economics",
    token: "owner-jwt",
    period: 7,
    fetchImpl: async (url, init) => {
      requested = { url: String(url), authorization: new Headers(init.headers).get("authorization") };
      return new Response(JSON.stringify(metrics), { status: 200 });
    },
  });
  assert.deepEqual(result, metrics);
  assert.equal(requested.url, "https://naelao.example/v1/analytics/runtime-economics?period=7");
  assert.equal(requested.authorization, "Bearer owner-jwt");
});

test("rejects incomplete or failed production responses", async () => {
  await assert.rejects(
    fetchRuntimeEconomics({ endpoint: "https://naelao.example/metrics", token: "t", fetchImpl: async () => new Response("bad", { status: 503 }) }),
    /Runtime economics request failed \(503\)/,
  );
  await assert.rejects(
    fetchRuntimeEconomics({ endpoint: "https://naelao.example/metrics", token: "t", fetchImpl: async () => new Response(JSON.stringify({ periodDays: 30 }), { status: 200 }) }),
    /missing numeric field: sampleCount/,
  );
});
