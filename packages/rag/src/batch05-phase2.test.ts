import { describe, expect, it, vi } from "vitest";
import { chunkStructuredMarkdown } from "./chunking.js";
import {
  formatNumberedCitations,
  verifyCitationCoordinate,
} from "./citations.js";
import { googleModeSearch, reciprocalRankFusion } from "./hybrid.js";
import { lookupSemanticCache } from "./semantic-cache.js";

describe("Batch 05 phase 2", () => {
  it("keeps Markdown tables intact", () => {
    const table = "| Name | Rent |\n| --- | ---: |\n| A | $100 |\n| B | $200 |";
    const chunks = chunkStructuredMarkdown(
      `# Lease\n\n${table}\n\n## Terms\n\n${"word ".repeat(80)}`,
      100
    );
    expect(chunks.some((chunk) => chunk.content.includes(table))).toBe(true);
    expect(
      chunks.find((chunk) => chunk.content.includes(table))?.headingPath
    ).toEqual(["Lease"]);
  });

  it("bounds oversized tables, repeats their headers, and keeps UTF-16 source coordinates", () => {
    const rows = Array.from({ length: 30 }, (_, index) => `| row ${index} | value ${index} |`).join("\r\n");
    const table = `| Name | Value |\r\n| --- | --- |\r\n${rows}`;
    const document = `# Records\r\n\r\n${table}`;
    const chunks = chunkStructuredMarkdown(document, 100);
    const tableChunks = chunks.filter((chunk) => chunk.content.startsWith("| Name | Value |"));

    expect(tableChunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.content.length <= 100)).toBe(true);
    expect(tableChunks.every((chunk) => chunk.content.startsWith("| Name | Value |\n| --- | --- |"))).toBe(true);
    expect(tableChunks.every((chunk) => JSON.stringify(chunk.headingPath) === JSON.stringify(["Records"]))).toBe(true);
    for (const chunk of tableChunks) {
      expect(document.slice(chunk.charOffset, chunk.charEnd)).toContain("| row ");
    }
  });

  it("rejects invalid structured chunk limits and preserves emoji at split points", () => {
    expect(() => chunkStructuredMarkdown("text", 0)).toThrow(RangeError);
    expect(() => chunkStructuredMarkdown("text", 32_769)).toThrow(RangeError);
    const chunks = chunkStructuredMarkdown(`${"a".repeat(9)}😀${"b".repeat(9)}`, 10);
    expect(chunks.map((chunk) => chunk.content).join("")).toBe(`${"a".repeat(9)}😀${"b".repeat(9)}`);
    expect(chunks.every((chunk) => chunk.content.length <= 10)).toBe(true);
  });

  it("only accepts semantic similarity strictly above .96", async () => {
    const query = vi.fn().mockResolvedValue({
      matches: [
        {
          id: "hit",
          score: 0.961,
          metadata: { expires_at: Date.now() + 60_000 },
        },
      ],
    });
    const get = vi.fn().mockResolvedValue("verified answer");
    await expect(
      lookupSemanticCache({ vectors: { query }, kv: { get } }, [1], { tenantId: "tenant", spaceId: "space" })
    ).resolves.toMatchObject({ text: "verified answer" });
    query.mockResolvedValue({
      matches: [
        {
          id: "miss",
          score: 0.96,
          metadata: { expires_at: Date.now() + 60_000 },
        },
      ],
    });
    await expect(
      lookupSemanticCache({ vectors: { query }, kv: { get } }, [1], { tenantId: "tenant", spaceId: "space" })
    ).resolves.toBeNull();
  });

  it("uses RRF k=60 and invokes web below .85", async () => {
    expect(
      reciprocalRankFusion([{ id: "a", score: 1 }], [{ id: "a", score: 1 }])
    ).toEqual([{ id: "a", score: 2 / 61 }]);
    const web = vi.fn().mockResolvedValue([]);
    await googleModeSearch(
      "query",
      { tenantId: "t", spaceId: "s", projectId: "p", roleRank: 1 },
      {
        cache: { lookup: async () => null, store: async () => undefined },
        dense: async () => [
          {
            id: "a",
            score: 0.84,
            content: "x",
            r2Key: "x",
            byteStart: 0,
            byteEnd: 1,
          },
        ],
        sparse: async () => [],
        web,
        emitTelemetry: () => undefined,
      }
    );
    expect(web).toHaveBeenCalledOnce();
  });

  it("numbers referenced citations and rejects forged coordinates", () => {
    const candidate = {
      docId: "doc",
      title: "Lease",
      snippet: "rent",
      r2Key: "kb/doc.txt",
      byteStart: 2,
      byteEnd: 6,
    };
    expect(
      formatNumberedCitations([candidate], "Rent [[doc:doc]].")
    ).toMatchObject({
      text: "Rent [1].",
      citations: [{ index: 1, docId: "doc" }],
    });
    expect(() =>
      verifyCitationCoordinate(candidate, { r2Key: "kb/other.txt", size: 10 })
    ).toThrow(/not accessible/);
  });
});
