import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export function evaluateRuntimeEconomics(metrics, minimumSample = 10_000) {
  const checks = {
    representativeSample: metrics.sampleCount >= minimumSample,
    tierOneTwoShareAtLeast95Percent: metrics.tierOneTwoShare >= 0.95,
    tierSixShareAtMost5Percent: metrics.tierSixShare <= 0.05,
    tierOneTwoP95Under5Ms: metrics.tierOneTwoP95DurationMs < 5,
  };
  return {
    periodDays: metrics.periodDays,
    sampleCount: metrics.sampleCount,
    minimumSample,
    checks,
    passed: Object.values(checks).every(Boolean),
    caveat: "This validates runtime distribution and latency only. Infrastructure cost and gross margin require billing-export attribution.",
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const path = process.argv[2];
  if (!path) throw new Error("Usage: node infra/scripts/evaluate-runtime-economics.mjs <runtime-economics.json>");
  const metrics = JSON.parse(await readFile(path, "utf8"));
  const result = evaluateRuntimeEconomics(metrics, Number(process.env.NAELAO_ECONOMICS_MIN_SAMPLE ?? 10_000));
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
