import { describe, expect, it } from "vitest";
import { meaningfulFactTokens, projectFactRelevance } from "./project-fact-relevance.js";

describe("project fact relevance", () => {
  it("ignores natural-language stop words and accepts complete fact intent", () => {
    expect(meaningfulFactTokens("What is the refund window?")).toEqual(["refund", "window"]);
    expect(projectFactRelevance("What is the refund window?", "refund policy window 30 days")).toBe(1);
  });

  it("rejects a cross-thread fact that only matches part of the query", () => {
    expect(projectFactRelevance("refund window", "refund policy 30 days")).toBe(0.5);
    expect(projectFactRelevance("refund window", "shipping window 5 days")).toBe(0.5);
  });
});
