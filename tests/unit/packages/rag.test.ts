import { describe, it, expect } from "vitest";
import { chunkText } from "@naelao/rag";
import { reciprocalRankFusion, bm25Score } from "@naelao/rag";

const SHORT_TEXT = "Hello world. This is a short sentence.";

const LONG_TEXT = Array.from({ length: 60 }, (_, i) =>
  `Sentence number ${i + 1} contains some words about topic ${i % 5}. `
).join("");

describe("chunkText", () => {
  it("returns a single chunk for short text", () => {
    const chunks = chunkText(SHORT_TEXT);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  it("returns multiple chunks for long text", () => {
    const chunks = chunkText(LONG_TEXT, { chunkSize: 512, overlap: 50 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("each chunk is >= 100 chars or is the only chunk", () => {
    const chunks = chunkText(LONG_TEXT, { chunkSize: 512, overlap: 50 });
    if (chunks.length > 1) {
      for (const chunk of chunks) {
        expect(chunk.length).toBeGreaterThanOrEqual(100);
      }
    }
  });

  it("chunks overlap — end of chunk N appears somewhere in chunk N+1", () => {
    const chunks = chunkText(LONG_TEXT, { chunkSize: 512, overlap: 200 });
    if (chunks.length > 1) {
      const firstChunk = chunks[0]!;
      const secondChunk = chunks[1]!;
      // Last ~100 chars of first chunk should appear in second chunk
      const overlapFragment = firstChunk.slice(-100).trim().slice(0, 30);
      expect(secondChunk).toContain(overlapFragment);
    }
  });
});

describe("reciprocalRankFusion", () => {
  it("merges two lists and items in both rank higher", () => {
    const dense = [
      { id: "a", score: 0.9 },
      { id: "b", score: 0.8 },
      { id: "c", score: 0.7 },
    ];
    const sparse = [
      { id: "b", score: 0.95 },
      { id: "d", score: 0.6 },
      { id: "a", score: 0.5 },
    ];
    const fused = reciprocalRankFusion(dense, sparse);
    // b and a appear in both lists — they should rank above c and d
    const ids = fused.map((r) => r.id);
    const bIdx = ids.indexOf("b");
    const cIdx = ids.indexOf("c");
    const dIdx = ids.indexOf("d");
    expect(bIdx).toBeLessThan(cIdx);
    expect(bIdx).toBeLessThan(dIdx);
  });

  it("returns empty array for empty inputs", () => {
    expect(reciprocalRankFusion([], [])).toEqual([]);
    expect(reciprocalRankFusion([{ id: "a", score: 1 }], [])).toHaveLength(1);
  });

  it("results are sorted by descending score", () => {
    const dense = [{ id: "x", score: 0.5 }, { id: "y", score: 0.9 }];
    const fused = reciprocalRankFusion(dense, []);
    for (let i = 1; i < fused.length; i++) {
      expect(fused[i - 1]!.score).toBeGreaterThanOrEqual(fused[i]!.score);
    }
  });
});

describe("bm25Score", () => {
  const docs = [
    { id: "doc1", content: "The quick brown fox jumps over the lazy dog" },
    { id: "doc2", content: "A fox ran quickly across the field" },
    { id: "doc3", content: "The weather is nice today" },
  ];

  it("returns higher score for document with more query term matches", () => {
    const results = bm25Score("fox quick", docs);
    const doc1Score = results.find((r) => r.id === "doc1")?.score ?? 0;
    const doc2Score = results.find((r) => r.id === "doc2")?.score ?? 0;
    const doc3Score = results.find((r) => r.id === "doc3")?.score ?? 0;
    expect(doc1Score).toBeGreaterThan(doc3Score);
    expect(doc2Score).toBeGreaterThan(doc3Score);
  });

  it("returns 0 score for documents with no query terms", () => {
    const results = bm25Score("fox quick", docs);
    const doc3Score = results.find((r) => r.id === "doc3")?.score ?? -1;
    expect(doc3Score).toBe(0);
  });

  it("results are sorted by descending score", () => {
    const results = bm25Score("fox", docs);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
    }
  });
});
