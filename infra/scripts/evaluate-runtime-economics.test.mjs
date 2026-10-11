import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRuntimeEconomics } from "./evaluate-runtime-economics.mjs";

test("passes only a representative 95/5 sample with sub-5ms Tier 1/2 p95", () => {
  const base = { periodDays: 30, sampleCount: 10_000, tierOneTwoShare: 0.95, tierSixShare: 0.05, tierOneTwoP95DurationMs: 4.9 };
  assert.equal(evaluateRuntimeEconomics(base).passed, true);
  assert.equal(evaluateRuntimeEconomics({ ...base, sampleCount: 9_999 }).passed, false);
  assert.equal(evaluateRuntimeEconomics({ ...base, tierOneTwoShare: 0.949 }).passed, false);
  assert.equal(evaluateRuntimeEconomics({ ...base, tierOneTwoP95DurationMs: 5 }).passed, false);
});
