export interface KnowledgeEvalCase {
  recordType: "case";
  caseId: string;
  language: string;
  reviewStatus: "synthetic_unreviewed" | "human_reviewed" | "needs_native_review";
  query: string;
  answerable: boolean;
  relevantChunkIds: string[];
  expectedCitationChunkIds: string[];
  expectedVersions: Record<string, string>;
  forbiddenChunkIds: string[];
}

export interface KnowledgeEvalResult {
  caseId: string;
  retrieved: Array<{ chunkId: string; score: number; sourceVersion?: string }>;
  citedChunkIds: string[];
  abstained: boolean;
  latencyMs: number;
  costMicrosUsd: number;
}

export interface KnowledgeEvalThresholds {
  minPrecisionAtK: number;
  minRecallAtK: number;
  minMrrAtK: number;
  minNdcgAtK: number;
  minCitationPrecision: number;
  minCitationRecall: number;
  minAbstentionAccuracy: number;
  maxP95LatencyMs: number;
  maxTotalCostMicrosUsd: number;
  maxForbiddenExposureCount: number;
  maxStaleCitationCount: number;
}

export function evaluateKnowledgeRetrieval(input: {
  cases: KnowledgeEvalCase[];
  results: KnowledgeEvalResult[];
  topK?: number;
  requiredLanguages?: string[];
  thresholds?: KnowledgeEvalThresholds | null;
}): {
  caseCount: number;
  metrics: Record<string, number | null>;
  languageReview: Record<string, { caseCount: number; reviewedCount: number; reviewComplete: boolean }>;
  readiness: { acceptanceEligible: false; reasons: string[] };
  thresholdEvaluation: { configured: true; passed: boolean; failed: string[] } | null;
  perCase: Array<Record<string, unknown>>;
};
