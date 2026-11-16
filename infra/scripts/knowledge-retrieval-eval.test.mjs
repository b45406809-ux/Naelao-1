import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { evaluateKnowledgeRetrieval, parseJsonLines } from "./knowledge-retrieval-eval.mjs";

const datasetText = await readFile(new URL("../../tests/eval-datasets/knowledge-retrieval-v1.jsonl", import.meta.url), "utf8");
const cases = parseJsonLines(datasetText, "dataset");

test("scores current citations, stale source versions, forbidden exposure, abstention, latency and cost", () => {
  const result = evaluateKnowledgeRetrieval({ cases, topK: 2, results: [
    { caseId: "synthetic-exact-sku", retrieved: [{ chunkId: "catalog-rx0042-v2", sourceVersion: "v2", score: 0.9 }],
      citedChunkIds: ["catalog-rx0042-v2"], abstained: false, latencyMs: 12, costMicrosUsd: 50 },
    { caseId: "synthetic-current-policy", retrieved: [
      { chunkId: "policy-reagent-k-v1", sourceVersion: "v1", score: 0.99 },
      { chunkId: "policy-reagent-k-v2", sourceVersion: "v2", score: 0.8 },
    ], citedChunkIds: ["policy-reagent-k-v2"], abstained: false, latencyMs: 24, costMicrosUsd: 100 },
    { caseId: "synthetic-no-answer", retrieved: [{ chunkId: "private-procurement-draft", sourceVersion: "v1", score: 0.7 }],
      citedChunkIds: [], abstained: true, latencyMs: 5, costMicrosUsd: 0 },
  ] });

  assert.equal(result.metrics.recallAtK, 1);
  assert.equal(result.metrics.citationPrecision, 1);
  assert.equal(result.metrics.citationRecall, 1);
  assert.equal(result.metrics.abstentionAccuracy, 1);
  assert.equal(result.metrics.p95LatencyMs, 24);
  assert.equal(result.metrics.totalCostMicrosUsd, 150);
  assert.equal(result.metrics.forbiddenExposureCount, 2);
  assert.equal(result.metrics.staleCitationCount, 0);
  assert.equal(result.readiness.acceptanceEligible, false);
  assert.equal(result.languageReview.en.reviewComplete, false);
  assert.equal(result.languageReview.sn.caseCount, 0);
  assert.equal(result.languageReview.nd.caseCount, 0);
  assert.ok(result.readiness.reasons.some((reason) => reason.includes("sn, nd")));
});

test("detects a stale cited version without disclosing query text in the report", () => {
  const result = evaluateKnowledgeRetrieval({ cases: [cases[1]], results: [{
    caseId: "synthetic-current-policy",
    retrieved: [{ chunkId: "policy-reagent-k-v2", sourceVersion: "v1", score: 1 }],
    citedChunkIds: ["policy-reagent-k-v2"], abstained: false, latencyMs: 1, costMicrosUsd: 0,
  }] });
  assert.equal(result.metrics.staleCitationCount, 1);
  assert.equal(JSON.stringify(result).includes(cases[1].query), false);
});

test("reports missing results and rejects out-of-scope citations, malformed cases and JSON lines", () => {
  const missing = evaluateKnowledgeRetrieval({ cases: [cases[0]], results: [] });
  assert.equal(missing.missingResultCount, 1);
  assert.equal(missing.readiness.acceptanceEligible, false);
  assert.throws(() => evaluateKnowledgeRetrieval({ cases: [cases[0]], results: [{
    caseId: cases[0].caseId, retrieved: [], citedChunkIds: ["not-returned"], abstained: false, latencyMs: 0, costMicrosUsd: 0,
  }] }), /absent from its retrieved/);
  assert.throws(() => evaluateKnowledgeRetrieval({ cases: [{ ...cases[0], answerable: false }], results: [] }), /answerability/);
  assert.throws(() => parseJsonLines("{broken", "fixture"), /line 1/);
});

test("compares caller-supplied thresholds without turning a local pass into release acceptance", () => {
  const thresholds = {
    minPrecisionAtK: 1, minRecallAtK: 1, minMrrAtK: 1, minNdcgAtK: 1,
    minCitationPrecision: 1, minCitationRecall: 1, minAbstentionAccuracy: 1,
    maxP95LatencyMs: 10, maxTotalCostMicrosUsd: 10, maxForbiddenExposureCount: 0, maxStaleCitationCount: 0,
  };
  const result = {
    caseId: cases[0].caseId, retrieved: [{ chunkId: "catalog-rx0042-v2", sourceVersion: "v2", score: 1 }],
    citedChunkIds: ["catalog-rx0042-v2"], abstained: false, latencyMs: 10, costMicrosUsd: 10,
  };
  const report = evaluateKnowledgeRetrieval({ cases: [cases[0]], results: [result], requiredLanguages: ["en"], thresholds });
  assert.deepEqual(report.thresholdEvaluation, { configured: true, passed: true, failed: [] });
  assert.equal(report.readiness.acceptanceEligible, false);
  const failing = evaluateKnowledgeRetrieval({ cases: [cases[0]], results: [{ ...result, costMicrosUsd: 11 }],
    requiredLanguages: ["en"], thresholds });
  assert.deepEqual(failing.thresholdEvaluation?.failed, ["maxTotalCostMicrosUsd"]);
  assert.throws(() => evaluateKnowledgeRetrieval({ cases: [cases[0]], results: [result], thresholds: { maxP95LatencyMs: 5 } }), /thresholds must define/);
});
