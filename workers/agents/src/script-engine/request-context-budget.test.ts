import { describe, expect, it } from "vitest";
import { boundReasonerRequestContext } from "./request-context-budget.js";

describe("complete reasoner request budget", () => {
  it("trims context fields while preserving the goal and valid JSON", () => {
    const payload = JSON.stringify({ goal: "keep this", conversation: "x".repeat(20_000), memory_context: "y".repeat(20_000) });
    const result = boundReasonerRequestContext("system", payload, [], 8_000, 1_000);
    const parsed = JSON.parse(result.user);
    expect(parsed.goal).toBe("keep this");
    expect(result.trimmedFields.length).toBeGreaterThan(0);
    expect(result.inputChars).toBeLessThanOrEqual(Math.floor((8_000 - 1_000 - 1_000) * 3.2));
  });

  it("fails closed when fixed instructions and schemas alone exceed the window", () => {
    expect(() => boundReasonerRequestContext("system".repeat(10_000), JSON.stringify({ goal: "g" }), [], 2_048, 1_500))
      .toThrow("reasoner_fixed_prompt_exceeds_context_budget");
  });
});
