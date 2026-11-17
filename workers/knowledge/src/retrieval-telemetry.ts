import type { GroundedSearchTelemetry } from "@naelao/rag";

const TIMING_KEYS = ["autorag_search_ms", "cache_lookup_ms", "dense_search_ms", "sparse_search_ms", "web_grounding_ms"] as const;
export type RetrievalTimingKey = typeof TIMING_KEYS[number];

export function recordPdfPreviewParseMetric(dataset: AnalyticsEngineDataset | undefined, outcome: "succeeded" | "failed", durationMs: number): void {
  try {
    const latency = Number.isFinite(durationMs) ? Math.max(0, Math.min(120_000, Math.round(durationMs))) : 0;
    dataset?.writeDataPoint({ blobs: ["knowledge_parse", "pdf", "preview", outcome], doubles: [latency], indexes: [] });
  } catch { /* telemetry failures must not change ingestion behavior */ }
}

export function recordProjectAccessMetric(dataset: AnalyticsEngineDataset | undefined, outcome: "not_found_or_unavailable" | "role_insufficient"): void {
  try { dataset?.writeDataPoint({ blobs: ["knowledge_authorization", "project_access", outcome], doubles: [1], indexes: [] }); }
  catch { /* telemetry failures must not change authorization behavior */ }
}

export function recordDocumentDeletionMetric(dataset: AnalyticsEngineDataset | undefined, outcome: "pending" | "complete" | "busy" | "error",
  durationMs: number, attempts = 0): void {
  try {
    const bounded = (value: number, maximum: number) => Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.round(value))) : 0;
    dataset?.writeDataPoint({ blobs: ["knowledge_cleanup", "document_deletion", outcome],
      doubles: [bounded(durationMs, 120_000), bounded(attempts, 100)], indexes: [] });
  } catch { /* telemetry failures must not change deletion behavior */ }
}

export function recordCitationMetric(dataset: AnalyticsEngineDataset | undefined,
  outcome: "delivered" | "not_found_or_denied" | "integrity_failed" | "unavailable"): void {
  try { dataset?.writeDataPoint({ blobs: ["knowledge_citation", outcome], doubles: [1], indexes: [] }); }
  catch { /* telemetry failures must not change citation authorization or delivery */ }
}

/** Produce bounded aggregate telemetry; caller, tenant, Space, Project and query data are omitted. */
export function buildPrivacySafeRetrievalTelemetry(input: {
  event: GroundedSearchTelemetry;
  timings: Record<string, number>;
  retrievalMode: "autorag" | "hybrid";
  lexicalSearch: "available" | "unavailable";
  resultCount: number;
}): { cache_hit: boolean; live_grounding: boolean; confidence: number; latency_ms: number;
  timings_ms: Partial<Record<RetrievalTimingKey, number>>; retrieval_mode: "autorag" | "hybrid";
  lexical_search: "available" | "unavailable"; result_count: number } {
  const bounded = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(120_000, Math.round(value))) : 0;
  const timings_ms: Partial<Record<RetrievalTimingKey, number>> = {};
  for (const key of TIMING_KEYS) if (Number.isFinite(input.timings[key])) timings_ms[key] = bounded(input.timings[key]!);
  return {
    cache_hit: input.event.cacheHit === true,
    live_grounding: input.event.liveGrounding === true,
    confidence: Number.isFinite(input.event.confidence) ? Math.round(Math.min(1, Math.max(0, input.event.confidence)) * 1_000) / 1_000 : 0,
    latency_ms: bounded(input.event.latencyMs), timings_ms,
    retrieval_mode: input.retrievalMode,
    lexical_search: input.lexicalSearch,
    result_count: Number.isSafeInteger(input.resultCount) ? Math.max(0, Math.min(100, input.resultCount)) : 0,
  };
}
