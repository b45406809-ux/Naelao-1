import { describe, expect, it } from "vitest";
import { modelForDelegationDepth } from "./reasoner.js";

describe("delegation-depth model tiering", () => {
  it("physically clamps depth 3 to the free edge model", () => {
    expect(modelForDelegationDepth(3, "anthropic/claude-opus-4-1")).toBe("@cf/meta/llama-3.2-3b-instruct");
    expect(modelForDelegationDepth(2)).toBe("groq/llama-3.3-70b-versatile");
  });
});
