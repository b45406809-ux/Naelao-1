import { describe, expect, it } from "vitest";
import { modelForDelegationDepth, preferredLanguageContext } from "./reasoner.js";

describe("delegation-depth model tiering", () => {
  it("physically clamps depth 3 to the free edge model", () => {
    expect(modelForDelegationDepth(3, "anthropic/claude-opus-4-1")).toBe("@cf/meta/llama-3.2-3b-instruct");
    expect(modelForDelegationDepth(2)).toBe("groq/llama-3.3-70b-versatile");
  });
});

describe("saved language preference context", () => {
  it("defers to an explicit current-turn language request and preserves code-switching", () => {
    const context = preferredLanguageContext("fr-CA");
    expect(context?.preferred_language).toBe("fr-CA");
    expect(context?.preferred_language_rule).toContain("An explicit language request in the current message wins");
    expect(context?.preferred_language_rule).toContain("Preserve mixed-language and code-switched input");
  });

  it("omits a preference when unset", () => {
    expect(preferredLanguageContext()).toBeUndefined();
  });
});
