#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const REVIEW_STATES = new Set(["synthetic_unreviewed", "human_reviewed", "needs_native_review"]);
const THRESHOLD_FIELDS = [
  "minPrecisionAtK", "minRecallAtK", "minMrrAtK", "minNdcgAtK", "minCitationPrecision", "minCitationRecall",
  "minAbstentionAccuracy", "maxP95LatencyMs", "maxTotalCostMicrosUsd", "maxForbiddenExposureCount", "maxStaleCitationCount",
];

export function parseJsonLines(text, label = "JSONL") {
  return text.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      throw new Error(`${label} line ${index + 1} is not valid JSON`);
    }
  });
}

/** Whitelist a Knowledge search response into a trace without content, query, title, or storage key. */
export function createKnowledgeSearchTrace({ caseId, response, abstained, latencyMs, costMicrosUsd }) {
  if (typeof caseId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(caseId)
      || !response || typeof response !== "object" || !Array.isArray(response.data)
      || typeof abstained !== "boolean" || !Number.isFinite(latencyMs) || latencyMs < 0
      || !Number.isFinite(costMicrosUsd) || costMicrosUsd < 0) {
    throw new Error("search trace inputs are invalid");
  }
  const retrieved = [];
  const citedChunkIds = [];
  for (const item of response.data) {
    if (!item || typeof item.chunk_id !== "string" || !item.chunk_id || item.chunk_id.length > 160
        || !Number.isFinite(item.score)) {
      throw new Error("search response contains an invalid candidate");
    }
    const citation = item.citation;
    if (citation !== null && citation !== undefined
        && (!citation || typeof citation !== "object" || citation.chunk_id !== item.chunk_id)) {
      throw new Error("search response contains an invalid citation identity");
    }
    const sourceRevision = citation?.source_revision;
    retrieved.push({ chunkId: item.chunk_id, score: item.score,
      ...(Number.isSafeInteger(sourceRevision) && sourceRevision > 0 ? { sourceVersion: String(sourceRevision) } : {}) });
    if (citation) citedChunkIds.push(item.chunk_id);
  }
  return { caseId, retrieved, citedChunkIds, abstained, latencyMs, costMicrosUsd };
}

function assertCase(sample, seen) {
  if (!sample || sample.recordType !== "case" || typeof sample.caseId !== "string"
      || !/^[A-Za-z0-9_-]{1,100}$/.test(sample.caseId) || seen.has(sample.caseId)) {
    throw new Error("benchmark contains an invalid or duplicate caseId");
  }
  if (typeof sample.language !== "string" || !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(sample.language)
      || !REVIEW_STATES.has(sample.reviewStatus) || typeof sample.answerable !== "boolean"
      || typeof sample.query !== "string" || sample.query.length > 2_000
      || !Array.isArray(sample.relevantChunkIds) || !Array.isArray(sample.forbiddenChunkIds)
      || !Array.isArray(sample.expectedCitationChunkIds) || sample.relevantChunkIds.length > 100
      || sample.forbiddenChunkIds.length > 100 || sample.expectedCitationChunkIds.length > 100 || !sample.expectedVersions
      || typeof sample.expectedVersions !== "object" || Array.isArray(sample.expectedVersions)) {
    throw new Error(`benchmark case ${sample.caseId} has invalid fields`);
  }
  if (sample.sourceLanguage !== undefined
      && (typeof sample.sourceLanguage !== "string" || !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(sample.sourceLanguage))) {
    throw new Error(`benchmark case ${sample.caseId} has an invalid sourceLanguage`);
  }
  const ids = [...sample.relevantChunkIds, ...sample.forbiddenChunkIds, ...sample.expectedCitationChunkIds];
  if (ids.some((id) => typeof id !== "string" || !id || id.length > 160)
      || new Set(sample.relevantChunkIds).size !== sample.relevantChunkIds.length
      || new Set(sample.forbiddenChunkIds).size !== sample.forbiddenChunkIds.length
      || new Set(sample.expectedCitationChunkIds).size !== sample.expectedCitationChunkIds.length
      || sample.relevantChunkIds.some((id) => sample.forbiddenChunkIds.includes(id))) {
    throw new Error(`benchmark case ${sample.caseId} has invalid chunk expectations`);
  }
  if (sample.answerable !== (sample.relevantChunkIds.length > 0)) {
    throw new Error(`benchmark case ${sample.caseId} answerability disagrees with relevant chunks`);
  }
  if (sample.expectedCitationChunkIds.some((id) => !sample.relevantChunkIds.includes(id))) {
    throw new Error(`benchmark case ${sample.caseId} expects citations outside relevant chunks`);
  }
  for (const [chunkId, version] of Object.entries(sample.expectedVersions)) {
    if (!sample.relevantChunkIds.includes(chunkId) || typeof version !== "string" || !version || version.length > 128) {
      throw new Error(`benchmark case ${sample.caseId} has an invalid expected source version`);
    }
  }
  seen.add(sample.caseId);
}

function average(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function percentile95(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null;
}

function rankedMetrics(sample, retrieved) {
  if (!sample.answerable) return { precisionAtK: null, recallAtK: null, reciprocalRank: null, ndcgAtK: null };
  const relevant = new Set(sample.relevantChunkIds);
  const hits = retrieved.map((item) => relevant.has(item.chunkId));
  const truePositives = hits.filter(Boolean).length;
  const firstRelevantRank = hits.indexOf(true) + 1;
  const dcg = hits.reduce((sum, isRelevant, index) => sum + (isRelevant ? 1 / Math.log2(index + 2) : 0), 0);
  const idealHits = Math.min(sample.relevantChunkIds.length, hits.length);
  const idealDcg = Array.from({ length: idealHits }, (_, index) => 1 / Math.log2(index + 2)).reduce((sum, value) => sum + value, 0);
  return {
    precisionAtK: hits.length ? truePositives / hits.length : 0,
    recallAtK: truePositives / sample.relevantChunkIds.length,
    reciprocalRank: firstRelevantRank ? 1 / firstRelevantRank : 0,
    ndcgAtK: idealDcg ? dcg / idealDcg : 0,
  };
}

function summarizeMetrics(perCase) {
  const completed = perCase.filter((item) => !item.missing);
  const answerable = completed.filter((item) => item.recallAtK !== null);
  return {
    precisionAtK: average(answerable.map((item) => item.precisionAtK)),
    recallAtK: average(answerable.map((item) => item.recallAtK)),
    mrrAtK: average(answerable.map((item) => item.reciprocalRank)),
    ndcgAtK: average(answerable.map((item) => item.ndcgAtK)),
    citationPrecision: average(completed.map((item) => item.citationPrecision)),
    citationRecall: average(completed.map((item) => item.citationRecall)),
    abstentionAccuracy: average(completed.map((item) => Number(item.abstentionCorrect))),
    p95LatencyMs: percentile95(completed.map((item) => item.latencyMs)),
    totalCostMicrosUsd: completed.reduce((total, item) => total + item.costMicrosUsd, 0),
    forbiddenExposureCount: completed.reduce((total, item) => total + item.forbiddenExposureCount, 0),
    staleCitationCount: completed.reduce((total, item) => total + item.staleCitationCount, 0),
  };
}

function compareThresholds(metrics, thresholds) {
  const thresholdMetricFields = {
    minPrecisionAtK: "precisionAtK", minRecallAtK: "recallAtK", minMrrAtK: "mrrAtK", minNdcgAtK: "ndcgAtK",
    minCitationPrecision: "citationPrecision", minCitationRecall: "citationRecall",
    minAbstentionAccuracy: "abstentionAccuracy", maxP95LatencyMs: "p95LatencyMs",
    maxTotalCostMicrosUsd: "totalCostMicrosUsd", maxForbiddenExposureCount: "forbiddenExposureCount",
    maxStaleCitationCount: "staleCitationCount",
  };
  const failed = Object.entries(thresholdMetricFields).filter(([threshold, metric]) => {
    const value = metrics[metric];
    return typeof value !== "number" || !(threshold.startsWith("min") ? value >= thresholds[threshold] : value <= thresholds[threshold]);
  }).map(([threshold]) => threshold);
  return { passed: failed.length === 0, failed };
}

function languagePairKey(sample) {
  return `${sample.language}->${sample.sourceLanguage ?? sample.language}`;
}

/** Score content-free retrieval traces against synthetic or reviewed cases. */
export function evaluateKnowledgeRetrieval({ cases, results, topK = 10, requiredLanguages = ["en", "sn", "nd"], thresholds = null }) {
  if (!Array.isArray(cases) || cases.length === 0 || cases.length > 10_000 || !Array.isArray(results)
      || results.length > cases.length) {
    throw new Error("cases and results must be nonempty/array inputs");
  }
  if (!Number.isSafeInteger(topK) || topK < 1 || topK > 100) throw new Error("topK must be an integer from 1 to 100");
  if (!Array.isArray(requiredLanguages) || requiredLanguages.length === 0
      || new Set(requiredLanguages).size !== requiredLanguages.length
      || requiredLanguages.some((language) => typeof language !== "string" || !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(language))) {
    throw new Error("requiredLanguages must contain unique language tags");
  }
  if (thresholds !== null) {
    if (!thresholds || typeof thresholds !== "object" || Array.isArray(thresholds)
        || Object.keys(thresholds).length !== THRESHOLD_FIELDS.length
        || THRESHOLD_FIELDS.some((field) => !Number.isFinite(thresholds[field]) || thresholds[field] < 0)
        || ["minPrecisionAtK", "minRecallAtK", "minMrrAtK", "minNdcgAtK", "minCitationPrecision", "minCitationRecall", "minAbstentionAccuracy"]
          .some((field) => thresholds[field] > 1)) {
      throw new Error("thresholds must define every supported non-negative quality, latency, cost and safety threshold");
    }
  }
  const ids = new Set();
  for (const sample of cases) assertCase(sample, ids);
  const resultById = new Map();
  for (const result of results) {
    if (!result || typeof result.caseId !== "string" || !ids.has(result.caseId) || resultById.has(result.caseId)
        || !Array.isArray(result.retrieved) || result.retrieved.length > 200
        || !Array.isArray(result.citedChunkIds) || result.citedChunkIds.length > 100
        || typeof result.abstained !== "boolean" || !Number.isFinite(result.latencyMs) || result.latencyMs < 0
        || !Number.isFinite(result.costMicrosUsd) || result.costMicrosUsd < 0) {
      throw new Error("results contain an invalid, duplicate, or unknown case");
    }
    const retrievedIds = new Set();
    for (const item of result.retrieved) {
      if (!item || typeof item.chunkId !== "string" || !item.chunkId || item.chunkId.length > 160
          || retrievedIds.has(item.chunkId) || !Number.isFinite(item.score)
          || (item.sourceVersion !== undefined && (typeof item.sourceVersion !== "string" || item.sourceVersion.length > 128))) {
        throw new Error(`result ${result.caseId} has invalid ranked candidates`);
      }
      retrievedIds.add(item.chunkId);
    }
    if (new Set(result.citedChunkIds).size !== result.citedChunkIds.length
        || result.citedChunkIds.some((id) => typeof id !== "string" || !retrievedIds.has(id))) {
      throw new Error(`result ${result.caseId} cites a chunk absent from its retrieved candidates`);
    }
    resultById.set(result.caseId, result);
  }

  const perCase = cases.map((sample) => {
    const result = resultById.get(sample.caseId);
    if (!result) return { caseId: sample.caseId, missing: true };
    const retrieved = result.retrieved.slice(0, topK);
    const retrievedIds = new Set(retrieved.map((item) => item.chunkId));
    const citations = new Set(result.citedChunkIds);
    const expectedCitations = new Set(sample.expectedCitationChunkIds);
    const citationTruePositives = [...citations].filter((id) => expectedCitations.has(id)).length;
    const staleCitations = [...citations].filter((id) => sample.expectedVersions[id] !== undefined
      && result.retrieved.find((item) => item.chunkId === id)?.sourceVersion !== sample.expectedVersions[id]);
    const forbiddenExposures = [...new Set([...retrievedIds, ...citations])].filter((id) => sample.forbiddenChunkIds.includes(id));
    const citationRecall = expectedCitations.size ? citationTruePositives / expectedCitations.size : (citations.size ? 0 : 1);
    const citationPrecision = citations.size ? citationTruePositives / citations.size : (expectedCitations.size ? 0 : 1);
    return {
      caseId: sample.caseId,
      ...rankedMetrics(sample, retrieved),
      citationPrecision,
      citationRecall,
      forbiddenExposureCount: forbiddenExposures.length,
      staleCitationCount: staleCitations.length,
      abstentionCorrect: result.abstained === !sample.answerable,
      latencyMs: result.latencyMs,
      costMicrosUsd: result.costMicrosUsd,
    };
  });
  const byLanguage = Object.fromEntries([...new Set([...requiredLanguages, ...cases.map((sample) => sample.language)])].sort().map((language) => {
    const languageCases = cases.filter((sample) => sample.language === language);
    const languageCaseIds = new Set(languageCases.map((sample) => sample.caseId));
    const languageResults = perCase.filter((item) => languageCaseIds.has(item.caseId));
    const completedCaseCount = languageResults.filter((item) => !item.missing).length;
    return [language, {
      caseCount: languageCases.length,
      completedCaseCount,
      missingResultCount: languageCases.length - completedCaseCount,
      reviewedCount: languageCases.filter((sample) => sample.reviewStatus === "human_reviewed").length,
      reviewComplete: languageCases.length > 0 && languageCases.every((sample) => sample.reviewStatus === "human_reviewed"),
      metrics: summarizeMetrics(languageResults),
    }];
  }));
  const languagePairs = Object.fromEntries([...new Set(cases.map(languagePairKey))].sort().map((languagePair) => {
    const pairCases = cases.filter((sample) => languagePairKey(sample) === languagePair);
    const pairCaseIds = new Set(pairCases.map((sample) => sample.caseId));
    const pairResults = perCase.filter((item) => pairCaseIds.has(item.caseId));
    const completedCaseCount = pairResults.filter((item) => !item.missing).length;
    return [languagePair, {
      caseCount: pairCases.length,
      completedCaseCount,
      missingResultCount: pairCases.length - completedCaseCount,
      reviewedCount: pairCases.filter((sample) => sample.reviewStatus === "human_reviewed").length,
      reviewComplete: pairCases.length > 0 && pairCases.every((sample) => sample.reviewStatus === "human_reviewed"),
      metrics: summarizeMetrics(pairResults),
    }];
  }));
  const metrics = summarizeMetrics(perCase);
  const forbiddenExposureCount = metrics.forbiddenExposureCount;
  const staleCitationCount = metrics.staleCitationCount;
  const allCasesReviewed = cases.every((sample) => sample.reviewStatus === "human_reviewed");
  const incompleteRequiredLanguages = requiredLanguages.filter((language) => !byLanguage[language]?.reviewComplete);
  const missingResultCount = perCase.filter((item) => item.missing).length;
  const completedCaseCount = cases.length - missingResultCount;
  const globalThresholdEvaluation = thresholds === null ? null : compareThresholds(metrics, thresholds);
  const languageThresholdEvaluations = thresholds === null ? null : Object.fromEntries(
    Object.entries(byLanguage).map(([language, report]) => [language, compareThresholds(report.metrics, thresholds)]),
  );
  const languagePairThresholdEvaluations = thresholds === null ? null : Object.fromEntries(
    Object.entries(languagePairs).map(([languagePair, report]) => [languagePair, compareThresholds(report.metrics, thresholds)]),
  );
  const thresholdEvaluation = thresholds === null ? null : {
    configured: true,
    passed: globalThresholdEvaluation.passed
      && Object.values(languageThresholdEvaluations).every((evaluation) => evaluation.passed)
      && Object.values(languagePairThresholdEvaluations).every((evaluation) => evaluation.passed),
    failed: globalThresholdEvaluation.failed,
    failedLanguages: Object.entries(languageThresholdEvaluations).filter(([, evaluation]) => !evaluation.passed).map(([language]) => language),
    byLanguage: languageThresholdEvaluations,
    failedLanguagePairs: Object.entries(languagePairThresholdEvaluations).filter(([, evaluation]) => !evaluation.passed).map(([languagePair]) => languagePair),
    byLanguagePair: languagePairThresholdEvaluations,
  };
  return {
    version: 2,
    topK,
    caseCount: cases.length,
    completedCaseCount,
    missingResultCount,
    metrics,
    thresholdEvaluation,
    requiredLanguages,
    languageReview: byLanguage,
    languagePairs,
    readiness: {
      acceptanceEligible: false,
      reasons: [
        ...(missingResultCount ? [`${missingResultCount} benchmark cases have no result`] : []),
        ...(forbiddenExposureCount ? [`${forbiddenExposureCount} forbidden candidates were retrieved or cited`] : []),
        ...(staleCitationCount ? [`${staleCitationCount} citations reference an unexpected source version`] : []),
        ...(!allCasesReviewed ? ["benchmark contains cases without human review"] : []),
        ...(incompleteRequiredLanguages.length ? [`required language coverage is missing or unreviewed: ${incompleteRequiredLanguages.join(", ")}`] : []),
        ...(thresholds === null ? ["quality, latency, cost, and safety thresholds are not configured"] : []),
        ...(thresholdEvaluation && !thresholdEvaluation.passed ? ["one or more aggregate, per-language, or language-pair thresholds failed"] : []),
        "human release approval, reviewed language data, and deployed/provider acceptance are outside this local evaluator",
      ],
    },
    perCase,
  };
}

async function main(argv) {
  const [datasetPath, resultsPath, topKArg, thresholdsPath] = argv;
  if (!datasetPath || !resultsPath) {
    throw new Error("usage: knowledge-retrieval-eval.mjs <dataset.jsonl> <results.jsonl> [top-k] [thresholds.json]");
  }
  const cases = parseJsonLines(await readFile(datasetPath, "utf8"), "dataset");
  const results = parseJsonLines(await readFile(resultsPath, "utf8"), "results");
  const topK = topKArg === undefined ? 10 : Number(topKArg);
  const thresholds = thresholdsPath === undefined ? null : JSON.parse(await readFile(thresholdsPath, "utf8"));
  process.stdout.write(`${JSON.stringify(evaluateKnowledgeRetrieval({ cases, results, topK, thresholds }), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "evaluation_failed"}\n`);
    process.exitCode = 1;
  });
}
