import { describe, expect, it } from "vitest";
import { buildPrivacySafeRetrievalTelemetry } from "./retrieval-telemetry.js";

describe("privacy-safe Knowledge retrieval telemetry", () => {
  it("keeps bounded aggregate metrics and omits tenant, Space, Project and query identifiers", () => {
    const payload = buildPrivacySafeRetrievalTelemetry({
      event: { tenantId: "tenant-secret", spaceId: "space-secret", projectId: "project-secret", cacheHit: false,
        liveGrounding: true, confidence: 1.4, latencyMs: 140_000 },
      timings: { dense_search_ms: 25.4, secret_timing_with_query: 99_999 }, retrievalMode: "hybrid",
      lexicalSearch: "unavailable", resultCount: 999,
    });
    const serialized = JSON.stringify(payload);
    expect(payload).toMatchObject({ confidence: 1, latency_ms: 120_000, result_count: 100,
      timings_ms: { dense_search_ms: 25 }, lexical_search: "unavailable" });
    expect(serialized).not.toContain("tenant-secret");
    expect(serialized).not.toContain("space-secret");
    expect(serialized).not.toContain("project-secret");
    expect(serialized).not.toContain("secret_timing_with_query");
  });
});
