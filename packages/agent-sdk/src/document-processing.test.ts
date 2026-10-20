import { describe, expect, it, vi } from "vitest";
import {
  type SummarizeDocumentInput,
  createDocumentSummaryWorkflowSource,
  createDocumentTools,
  documentProcessingSavings,
  summarizeDocumentInChunks,
} from "./document-processing.js";

describe("document-processing SDK", () => {
  it("uses host operation dispatch with no model override or key", async () => {
    const dispatch = vi.fn(async () => ({ text: "summary" }));
    await createDocumentTools(dispatch).summarize({
      text: "source",
      sourceId: "doc-a",
    });
    expect(dispatch).toHaveBeenCalledWith("document.summarize", {
      text: "source",
      sourceId: "doc-a",
    });
  });
  it("preserves the full input through chunking including late facts and emoji boundaries", async () => {
    const text = `${"x".repeat(15_999)}😀${"y".repeat(20_000)}IMPORTANT: revised deadline 2027-02-01`;
    const summarize = vi.fn(async (_input: SummarizeDocumentInput) => ({
      text: "part summary",
      usage: { model: "test", inputTokens: 20, outputTokens: 2 },
    }));
    await summarizeDocumentInChunks({ summarize }, { text });
    const sourceCalls = summarize.mock.calls.slice(0, -1);
    expect(sourceCalls.map((call) => call[0].text).join("")).toBe(text);
    expect(summarize).toHaveBeenCalledTimes(4);
  });
  it("rejects oversized work before paying for a partial summary", async () => {
    const summarize = vi.fn();
    await expect(
      summarizeDocumentInChunks({ summarize }, { text: "x".repeat(160_001) })
    ).rejects.toThrow("partitioned_workflow");
    expect(summarize).not.toHaveBeenCalled();
  });
  it("validates summary options and rejects oversized or malformed gateway results", async () => {
    const summarize = vi.fn(async (_input: SummarizeDocumentInput) => ({
      text: "ok",
      usage: { model: "test", inputTokens: 1, outputTokens: 1 },
    }));
    await expect(
      summarizeDocumentInChunks(
        { summarize },
        { text: "source", instructions: "x".repeat(8_001) }
      )
    ).rejects.toThrow("document_summary_options_invalid");
    expect(summarize).not.toHaveBeenCalled();
    summarize.mockResolvedValueOnce({
      text: "x".repeat(16_001),
      usage: { model: "test", inputTokens: 1, outputTokens: 1 },
    });
    await expect(
      summarizeDocumentInChunks({ summarize }, { text: "source" })
    ).rejects.toThrow("document_summary_result_invalid");
  });
  it("does not assume preprocessing saves money on a cheap or cached downstream model", () => {
    const input = {
      originalTokens: 100_000,
      processedTokens: 40_000,
      processingCostUsd: 0.004,
      downstreamInputUsdPerToken: 0.05 / 1_000_000,
    };
    expect(documentProcessingSavings(input)).toBeCloseTo(-0.001);
    expect(documentProcessingSavings({ ...input, reuseCount: 5 })).toBeCloseTo(
      0.011
    );
    expect(
      documentProcessingSavings({ ...input, downstreamInputUsdPerToken: null })
    ).toBeNull();
    expect(
      documentProcessingSavings({
        originalTokens: Number.MAX_SAFE_INTEGER,
        processedTokens: 0,
        processingCostUsd: 0,
        downstreamInputUsdPerToken: Number.MAX_VALUE,
      })
    ).toBeNull();
  });
  it("generates a resumable extension workflow using scoped host document operations", () => {
    const source = createDocumentSummaryWorkflowSource();
    expect(source).toContain(
      'ctx.tools.call("partition-source", "document.partition"'
    );
    expect(source).toContain('"summarize-" + chunk.index');
    expect(source).toContain(
      'ctx.tools.call("merge-summary", "document.summarize"'
    );
    expect(source).toContain("sourceHash: manifest.sourceHash");
    expect(source).not.toContain("apiKey");
  });
});
