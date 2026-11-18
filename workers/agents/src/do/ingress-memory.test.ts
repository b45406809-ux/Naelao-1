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

  it("filters personal rows to the active actor and retains bounded source identifiers", () => {
    const rendered = renderIngressMemory([
      { id: "own-fact", layer: "structured_fact", user_id: "alice", source_updated_at: "2026-11-18T00:00:00.000Z", text: "Alice's permitted preference", score: 0.95 },
      { id: "other-fact", layer: "episodic", user_id: "bob", text: "Bob's private detail", score: 1 },
      { id: "space-fact", layer: "structured_fact", text: "Shared approved fact", score: 0.9 },
    ], "alice");
    expect(rendered).toContain("id=own-fact");
    expect(rendered).toContain("layer=structured_fact");
    expect(rendered).toContain("source_updated_at=2026-11-18T00:00:00.000Z");
    expect(rendered).toContain("Shared approved fact");
    expect(rendered).not.toContain("Bob's private detail");
    expect(rendered).not.toContain("other-fact");
  });

  it("excludes actor-attributed personal rows when the run has no actor", () => {
    expect(renderIngressMemory([{ user_id: "alice", text: "private", score: 1 }])).toBeUndefined();
  });
});
