import { describe, expect, it } from "vitest";
import { renderIngressMemory } from "./NaelaoAgentDO.js";

describe("renderIngressMemory", () => {
  it("keeps only high-confidence bounded reference context", () => {
    const rendered = renderIngressMemory([
      { text: "unrelated low score", score: 0.79 },
      { text: "launch budget is 100", score: 0.91, relevance_score: 0.93 },
      { text: "another admitted fact", score: 0.8 },
    ]);
    expect(rendered).toContain("launch budget is 100");
    expect(rendered).toContain("another admitted fact");
    expect(rendered).not.toContain("unrelated low score");
  });

  it("caps individual entries and total context", () => {
    const rendered = renderIngressMemory(
      Array.from({ length: 10 }, (_, index) => ({ text: `${index}-${"x".repeat(1000)}`, score: 1 })),
    );
    expect(rendered?.length).toBeLessThanOrEqual(4000);
    expect(rendered?.split("\n").length).toBeLessThanOrEqual(6);
  });
});
