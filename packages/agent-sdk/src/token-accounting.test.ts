import { describe, expect, it } from "vitest";
import { MAX_PROVIDER_USAGE_TOKENS, estimateTextTokens, validProviderUsage } from "./token-accounting.js";

describe("provider token accounting boundaries", () => {
  it("accepts valid usage at the combined upper limit", () => {
    expect(validProviderUsage({ input_tokens: MAX_PROVIDER_USAGE_TOKENS - 1, output_tokens: 1 }))
      .toEqual({ input_tokens: MAX_PROVIDER_USAGE_TOKENS - 1, output_tokens: 1 });
  });

  it("rejects excessive and overflow-prone values instead of trusting malformed provider metadata", () => {
    expect(validProviderUsage({ input_tokens: MAX_PROVIDER_USAGE_TOKENS, output_tokens: 1 })).toBeUndefined();
    expect(validProviderUsage({ input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: Number.MAX_SAFE_INTEGER })).toBeUndefined();
    expect(validProviderUsage([1, 2])).toBeUndefined();
    const hostile = Object.defineProperty({}, "input_tokens", { get() { throw new Error("hostile usage getter"); } });
    expect(validProviderUsage(hostile)).toBeUndefined();
  });

  it("keeps the streaming estimate finite for large practical strings", () => {
    expect(estimateTextTokens("x".repeat(1_000_000))).toBe(259_741);
  });
});
