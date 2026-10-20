import { describe, expect, it } from "vitest";
import { calculateResourceCredits, CREDITS_PER_USD, estimateRequestCostCredits, tokensToCredits, tokensToCreditsAtPrice } from "./credits.js";

describe("standard credit table", () => {
  it("uses one cent credits and exact resource rates", () => {
    expect(CREDITS_PER_USD).toBe(100);
    expect(calculateResourceCredits("isolate_run", 100)).toBe(1);
    expect(calculateResourceCredits("workflow_step", 20)).toBe(1);
    expect(calculateResourceCredits("browser_scrape", 10)).toBe(1);
    expect(calculateResourceCredits("chromium_snapshot", 2)).toBe(2);
    expect(calculateResourceCredits("container_hour", 2)).toBe(10);
    expect(calculateResourceCredits("voice_minute", 2)).toBe(8);
  });
  it("charges provider cost plus margin and makes BYOK free", () => {
    expect(tokensToCredits(1_000_000, 0, "claude-sonnet-4-6")).toBe(345);
    expect(tokensToCredits(1_000_000, 0, "claude-sonnet-4-6", true)).toBe(0);
  });
  it("settles dynamic models from explicit USD-per-token catalog prices", () => {
    expect(tokensToCreditsAtPrice(1_000_000, 500_000, 0.000001, 0.000002)).toBe(230);
    expect(tokensToCreditsAtPrice(10, 10, 0, 0)).toBe(1);
    expect(() => tokensToCreditsAtPrice(1, 1, Number.NaN, 0)).toThrow("token prices");
    expect(() => tokensToCreditsAtPrice(1, 1, 0, 1.01)).toThrow("token prices");
  });
  it("reserves from serialized UTF-8 request bytes and the exact output-token cap", () => {
    expect(estimateRequestCostCredits(1_000, 1_500, "openrouter/test", { inputUsdPerToken: 0.000001, outputUsdPerToken: 0.000002 })).toEqual({
      estimatedInputTokens: 1_000, reservedOutputTokens: 1_500, estimatedCredits: 1, method: "utf8_bytes_plus_output_cap",
    });
    expect(() => estimateRequestCostCredits(-1, 10, "test")).toThrow("serializedRequestBytes");
    expect(() => estimateRequestCostCredits(100, 200_001, "test")).toThrow("maxOutputTokens");
  });
  it("uses explicit host pricing for native task providers outside the model catalog", () => {
    const estimate = estimateRequestCostCredits(10_000, 0, "scaledown/compress", {
      inputUsdPerToken: 0.000004,
      outputUsdPerToken: 0,
    });
    expect(estimate.estimatedInputTokens).toBe(10_000);
    expect(estimate.reservedOutputTokens).toBe(0);
    expect(estimate.estimatedCredits).toBe(tokensToCreditsAtPrice(10_000, 0, 0.000004, 0));
  });
});
