import { describe, expect, it } from "vitest";
import { estimateTokens, TOOL_OUTPUT_TOKEN_LIMIT } from "./tool-output.js";

describe("tool output context estimate", () => {
  it("uses a conservative estimate for multibyte text instead of counting UTF-16 units", () => {
    const chinese = "漢".repeat(5_000);
    expect(chinese.length).toBe(5_000);
    expect(estimateTokens(chinese)).toBeGreaterThan(TOOL_OUTPUT_TOKEN_LIMIT);
  });

  it("counts astral characters by their UTF-8 width", () => {
    expect(estimateTokens("😀")).toBe(2);
    expect(estimateTokens("x".repeat(3_000))).toBe(1_000);
  });
});
