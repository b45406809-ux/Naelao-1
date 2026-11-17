import { describe, expect, it, vi } from "vitest";
import { buildPrivacySafeRetrievalTelemetry, recordCitationMetric, recordDocumentDeletionMetric, recordPdfPreviewParseMetric,
  recordKnowledgeFilePreviewParseMetric, recordProjectAccessMetric, recordWebsitePreviewFailureMetric } from "./retrieval-telemetry.js";

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

  it("emits fixed PDF preview parse outcomes and isolates Analytics failures", () => {
    const writeDataPoint = vi.fn();
    recordPdfPreviewParseMetric({ writeDataPoint } as never, "failed", 120_500);
    expect(writeDataPoint).toHaveBeenCalledWith({ blobs: ["knowledge_parse", "pdf", "preview", "failed"], doubles: [120_000], indexes: [] });
    expect(() => recordPdfPreviewParseMetric({ writeDataPoint: () => { throw new Error("offline"); } } as never, "succeeded", 2)).not.toThrow();
  });

  it("labels DOCX, XLSX and PPTX parse outcomes with fixed non-content identifiers", () => {
    const writeDataPoint = vi.fn();
    recordKnowledgeFilePreviewParseMetric({ writeDataPoint } as never, "xlsx", "succeeded", 12.4);
    expect(writeDataPoint).toHaveBeenCalledWith({ blobs: ["knowledge_parse", "xlsx", "preview", "succeeded"], doubles: [12], indexes: [] });
    recordKnowledgeFilePreviewParseMetric({ writeDataPoint } as never, "pptx", "failed", 6);
    expect(writeDataPoint).toHaveBeenLastCalledWith({ blobs: ["knowledge_parse", "pptx", "preview", "failed"], doubles: [6], indexes: [] });
  });

  it("records fixed authorization denial categories without caller or resource identifiers", () => {
    const writeDataPoint = vi.fn();
    recordProjectAccessMetric({ writeDataPoint } as never, "not_found_or_unavailable");
    expect(writeDataPoint).toHaveBeenCalledWith({ blobs: ["knowledge_authorization", "project_access", "not_found_or_unavailable"], doubles: [1], indexes: [] });
    expect(() => recordProjectAccessMetric({ writeDataPoint: () => { throw new Error("offline"); } } as never, "role_insufficient")).not.toThrow();
  });

  it("records bounded deletion outcomes without making cleanup depend on Analytics", () => {
    const writeDataPoint = vi.fn();
    recordDocumentDeletionMetric({ writeDataPoint } as never, "pending", 121_000, 500);
    expect(writeDataPoint).toHaveBeenCalledWith({ blobs: ["knowledge_cleanup", "document_deletion", "pending"], doubles: [120_000, 100], indexes: [] });
    expect(() => recordDocumentDeletionMetric({ writeDataPoint: () => { throw new Error("offline"); } } as never, "complete", 1)).not.toThrow();
  });

  it("records citation delivery states with no document, chunk, or tenant key", () => {
    const writeDataPoint = vi.fn();
    recordCitationMetric({ writeDataPoint } as never, "integrity_failed");
    expect(writeDataPoint).toHaveBeenCalledWith({ blobs: ["knowledge_citation", "integrity_failed"], doubles: [1], indexes: [] });
    expect(() => recordCitationMetric({ writeDataPoint: () => { throw new Error("offline"); } } as never, "unavailable")).not.toThrow();
  });

  it("maps unexpected website error values to a fixed failure label and bounds retries", () => {
    const writeDataPoint = vi.fn();
    recordWebsitePreviewFailureMetric({ writeDataPoint } as never, "secret-url-token-tenant-a", 1000);
    expect(writeDataPoint).toHaveBeenCalledWith({ blobs: ["knowledge_source_preview", "owner_approved_fetch", "other"], doubles: [100], indexes: [] });
    expect(JSON.stringify(writeDataPoint.mock.calls)).not.toContain("secret-url-token-tenant-a");
    expect(() => recordWebsitePreviewFailureMetric({ writeDataPoint: () => { throw new Error("offline"); } } as never,
      "website_source_empty", 1)).not.toThrow();
  });
});
