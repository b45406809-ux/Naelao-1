import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createKnowledgeSearchTrace, evaluateKnowledgeRetrieval, parseJsonLines } from "./knowledge-retrieval-eval.mjs";

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

test("whitelists a Knowledge search response into a content-free source-version trace", () => {
  const response = {
    query: "private query text",
    data: [{ chunk_id: "doc-1_chunk_0", score: 0.9, content: "private source text", title: "Private title",
      citation: { chunk_id: "doc-1_chunk_0", source_revision: 4, r2_key: "private/r2/key", content_hash: "secret" } }],
    citations: [{ r2Key: "private/r2/key", snippet: "private snippet" }],
  };
  const trace = createKnowledgeSearchTrace({ caseId: "safe-case", response, abstained: false, latencyMs: 5, costMicrosUsd: 0 });
  assert.deepEqual(trace, { caseId: "safe-case", retrieved: [{ chunkId: "doc-1_chunk_0", score: 0.9, sourceVersion: "4" }],
    citedChunkIds: ["doc-1_chunk_0"], abstained: false, latencyMs: 5, costMicrosUsd: 0 });
  assert.equal(JSON.stringify(trace).includes("private"), false);
  assert.throws(() => createKnowledgeSearchTrace({ caseId: "bad", response: { data: [{ chunk_id: "doc-1_chunk_0",
    score: 0.9, citation: { chunk_id: "other_chunk_0" } }] }, abstained: false, latencyMs: 0, costMicrosUsd: 0 }), /citation identity/);
});

test("reports missing results and rejects out-of-scope citations, malformed cases and JSON lines", () => {
  const missing = evaluateKnowledgeRetrieval({ cases: [cases[0]], results: [] });
  assert.equal(missing.missingResultCount, 1);
  assert.equal(missing.readiness.acceptanceEligible, false);
  assert.throws(() => evaluateKnowledgeRetrieval({ cases: [cases[0]], results: [{
    caseId: cases[0].caseId, retrieved: [], citedChunkIds: ["not-returned"], abstained: false, latencyMs: 0, costMicrosUsd: 0,
  }] }), /absent from its retrieved/);
  assert.throws(() => evaluateKnowledgeRetrieval({ cases: [{ ...cases[0], answerable: false }], results: [] }), /answerability/);
  assert.throws(() => evaluateKnowledgeRetrieval({ cases: [{ ...cases[0], sourceLanguage: "bad_tag" }], results: [] }), /invalid sourceLanguage/);
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
  assert.deepEqual(report.thresholdEvaluation, { configured: true, passed: true, failed: [], failedLanguages: [],
    byLanguage: { en: { passed: true, failed: [] } }, failedLanguagePairs: [],
    byLanguagePair: { "en->en": { passed: true, failed: [] } } });
  assert.equal(report.readiness.acceptanceEligible, false);
  const failing = evaluateKnowledgeRetrieval({ cases: [cases[0]], results: [{ ...result, costMicrosUsd: 11 }],
    requiredLanguages: ["en"], thresholds });
  assert.deepEqual(failing.thresholdEvaluation?.failed, ["maxTotalCostMicrosUsd"]);
  assert.throws(() => evaluateKnowledgeRetrieval({ cases: [cases[0]], results: [result], thresholds: { maxP95LatencyMs: 5 } }), /thresholds must define/);
});

test("reports quality, safety, latency and cost separately for each query language", () => {
  const shonaCase = { ...cases[0], caseId: "synthetic-shona", language: "sn",
    sourceLanguage: "en",
    relevantChunkIds: ["shona-guide-v1"], expectedCitationChunkIds: ["shona-guide-v1"],
    expectedVersions: { "shona-guide-v1": "v1" }, forbiddenChunkIds: [] };
  const englishFromShonaCase = { ...cases[0], caseId: "synthetic-en-from-shona", sourceLanguage: "sn",
    relevantChunkIds: ["shona-source-for-english-v1"], expectedCitationChunkIds: ["shona-source-for-english-v1"],
    expectedVersions: { "shona-source-for-english-v1": "v1" }, forbiddenChunkIds: [] };
  const shonaResult = { caseId: shonaCase.caseId,
    retrieved: [{ chunkId: "unrelated-guide-v1", sourceVersion: "v1", score: 0.8 }],
    citedChunkIds: [], abstained: false, latencyMs: 80, costMicrosUsd: 25 };
  const exactResult = { caseId: cases[0].caseId,
    retrieved: [{ chunkId: "catalog-rx0042-v2", sourceVersion: "v2", score: 1 }],
    citedChunkIds: ["catalog-rx0042-v2"], abstained: false, latencyMs: 10, costMicrosUsd: 5 };
  const englishFromShonaResult = { caseId: englishFromShonaCase.caseId,
    retrieved: [{ chunkId: "shona-source-for-english-v1", sourceVersion: "v1", score: 0.95 }],
    citedChunkIds: ["shona-source-for-english-v1"], abstained: false, latencyMs: 20, costMicrosUsd: 0 };
  const report = evaluateKnowledgeRetrieval({ cases: [cases[0], shonaCase, englishFromShonaCase],
    results: [exactResult, shonaResult, englishFromShonaResult],
    requiredLanguages: ["en", "sn"], thresholds: {
      minPrecisionAtK: 0, minRecallAtK: 0.5, minMrrAtK: 0, minNdcgAtK: 0,
      minCitationPrecision: 0, minCitationRecall: 0.5, minAbstentionAccuracy: 0,
      maxP95LatencyMs: 100, maxTotalCostMicrosUsd: 30, maxForbiddenExposureCount: 0, maxStaleCitationCount: 0,
    } });

  assert.equal(report.version, 2);
  assert.equal(report.metrics.recallAtK, 2 / 3);
  assert.equal(report.languageReview.en.metrics.recallAtK, 1);
  assert.equal(report.languageReview.en.metrics.p95LatencyMs, 20);
  assert.equal(report.languageReview.sn.metrics.recallAtK, 0);
  assert.equal(report.languageReview.sn.metrics.citationRecall, 0);
  assert.equal(report.languageReview.sn.metrics.p95LatencyMs, 80);
  assert.equal(report.languageReview.sn.metrics.totalCostMicrosUsd, 25);
  assert.equal(report.languageReview.sn.completedCaseCount, 1);
  assert.equal(report.languagePairs["sn->en"].metrics.recallAtK, 0);
  assert.equal(report.languagePairs["en->sn"].metrics.recallAtK, 1);
  assert.equal(report.languagePairs["en->en"].metrics.recallAtK, 1);
  assert.equal(report.thresholdEvaluation?.passed, false);
  assert.deepEqual(report.thresholdEvaluation?.failed, []);
  assert.deepEqual(report.thresholdEvaluation?.failedLanguages, ["sn"]);
  assert.deepEqual(report.thresholdEvaluation?.failedLanguagePairs, ["sn->en"]);
  assert.equal(report.thresholdEvaluation?.byLanguage?.en?.passed, true);
  assert.ok(report.thresholdEvaluation?.byLanguage?.sn?.failed.includes("minRecallAtK"));
  assert.ok(report.thresholdEvaluation?.byLanguagePair?.["sn->en"]?.failed.includes("minRecallAtK"));
  assert.equal(report.readiness.acceptanceEligible, false);
});
