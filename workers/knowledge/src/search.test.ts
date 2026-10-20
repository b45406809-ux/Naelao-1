import { describe, expect, it } from "vitest";
import { hybridRank, sparseRank } from "./search.js";
import type { GroundedSearchHit } from "@naelao/rag";

function hit(id: string, content: string): GroundedSearchHit {
  return { id, score: 0.5, content, r2Key: `kb/${id}`, byteStart: 0, byteEnd: content.length };
}

describe("Knowledge Worker sparse ranking bounds", () => {
  it("ranks only the supplied candidate set and retains the original full hit", () => {
    const relevant = hit("relevant", "The customer requires an audit export");
    const irrelevant = hit("irrelevant", "A different topic");
    expect(sparseRank("audit export", [irrelevant, relevant])[0]).toMatchObject({ id: relevant.id, content: relevant.content });
    expect(hybridRank("audit export", [relevant], [irrelevant, relevant])[0]?.id).toBe("relevant");
  });

  it("rejects empty or oversized queries and broad candidate populations", () => {
    const candidates = [hit("one", "hello")];
    expect(() => sparseRank(" ", candidates)).toThrow(RangeError);
    expect(() => sparseRank("q".repeat(1_001), candidates)).toThrow(RangeError);
    expect(() => sparseRank("query", Array.from({ length: 201 }, (_, i) => hit(String(i), "x"))))
      .toThrow(/at most 200/);
  });

  it("caps text scanned per candidate while keeping returned content unchanged", () => {
    const large = hit("large", `audit ${"noise ".repeat(10_000)}`);
    expect(sparseRank("audit", [large])[0]?.content).toBe(large.content);
    const lateMatch = hit("late", `${"noise ".repeat(4_000)} audit`);
    expect(sparseRank("audit", [lateMatch])).toEqual([]);
    expect(() => sparseRank("audit", [{ ...large, content: 1 as never }])).toThrow(TypeError);
  });
});
