import assert from "node:assert/strict";
import test from "node:test";
import { evaluateUnitEconomics } from "./evaluate-unit-economics.mjs";

const complete = {
  periodDays: 30,
  activePaidUsers: 100,
  netRevenueUsd: 2_900,
  costsUsd: { workers: 25, durableObjects: 20, r2Operations: 10, egress: 5, model: 70, browser: 20, containers: 30, paymentProcessing: 20, customerSupport: 10, otherCostOfRevenue: 0 },
};

test("proves the stated thresholds only from complete billing attribution", () => {
  const result = evaluateUnitEconomics(complete);
  assert.equal(result.passed, true);
  assert.equal(result.monthlyCostPerPaidUserUsd, 1.8);
  assert.ok(result.grossMargin > 0.92);
});

test("fails closed on omitted categories or a missed threshold", () => {
  const incomplete = structuredClone(complete);
  delete incomplete.costsUsd.egress;
  assert.equal(evaluateUnitEconomics(incomplete).passed, false);
  assert.match(evaluateUnitEconomics(incomplete).failures.join(" "), /egress/);
  assert.equal(evaluateUnitEconomics({ ...complete, costsUsd: { ...complete.costsUsd, containers: 100 } }).passed, false);
});
