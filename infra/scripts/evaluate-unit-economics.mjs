import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const INFRASTRUCTURE_COST_CATEGORIES = Object.freeze([
  "workers",
  "durableObjects",
  "r2Operations",
  "egress",
  "model",
  "browser",
  "containers",
]);
export const REQUIRED_COST_CATEGORIES = Object.freeze([
  ...INFRASTRUCTURE_COST_CATEGORIES,
  "paymentProcessing",
  "customerSupport",
  "otherCostOfRevenue",
]);

function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function evaluateUnitEconomics(input) {
  const failures = [];
  if (!Number.isInteger(input.activePaidUsers) || input.activePaidUsers <= 0) failures.push("activePaidUsers must be a positive integer");
  if (!finiteNonNegative(input.netRevenueUsd) || input.netRevenueUsd <= 0) failures.push("netRevenueUsd must be positive");
  if (!Number.isInteger(input.periodDays) || input.periodDays <= 0) failures.push("periodDays must be a positive integer");
  const costs = input.costsUsd ?? {};
  for (const category of REQUIRED_COST_CATEGORIES) {
    if (!finiteNonNegative(costs[category])) failures.push(`missing or invalid costsUsd.${category}`);
  }
  if (failures.length) return { passed: false, failures };

  const totalCostUsd = REQUIRED_COST_CATEGORIES.reduce((sum, category) => sum + costs[category], 0);
  const infrastructureCostUsd = INFRASTRUCTURE_COST_CATEGORIES.reduce((sum, category) => sum + costs[category], 0);
  const monthlyFactor = 30 / input.periodDays;
  const monthlyCostPerPaidUserUsd = infrastructureCostUsd * monthlyFactor / input.activePaidUsers;
  const grossMargin = (input.netRevenueUsd - totalCostUsd) / input.netRevenueUsd;
  const checks = {
    monthlyCostPerPaidUserAtMost210: monthlyCostPerPaidUserUsd <= 2.10,
    grossMarginAtLeast92Percent: grossMargin >= 0.92,
  };
  return {
    passed: Object.values(checks).every(Boolean),
    failures: [],
    infrastructureCostUsd,
    totalCostUsd,
    monthlyCostPerPaidUserUsd,
    grossMargin,
    checks,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const path = process.argv[2];
  if (!path) throw new Error("Usage: node infra/scripts/evaluate-unit-economics.mjs <billing-attribution.json>");
  const result = evaluateUnitEconomics(JSON.parse(await readFile(path, "utf8")));
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
