import { describe, expect, it } from "vitest";
import { calculateResourceCredits, CREDITS_PER_USD, estimateRequestCostCredits, EXTENSION_RESOURCE_UNIT_PRICES, priceExtensionResourceUnits, tokensToCredits, tokensToCreditsAtPrice } from "./credits.js";

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

describe("extension resource unit prices (D8)", () => {
  const MIB = 1024 * 1024;
  const price = (invocations: number, jobUnits: number, bytes: number) => priceExtensionResourceUnits({ invocations, jobUnits, bytes }).credits;

  it("keeps the versioned table at the approved starting rates", () => {
    expect(EXTENSION_RESOURCE_UNIT_PRICES.version).toBe("ext-units-2026-11-25");
    expect(EXTENSION_RESOURCE_UNIT_PRICES.invocationsPerCredit).toBe(100);
    expect(EXTENSION_RESOURCE_UNIT_PRICES.jobUnitsPerCredit).toBe(1);
    expect(EXTENSION_RESOURCE_UNIT_PRICES.bytesPerCredit).toBe(100 * MIB);
  });

  it("rounds invocations up per 100 and job units at 1 credit each", () => {
    expect(price(0, 0, 0)).toBe(0);
    expect(price(1, 0, 0)).toBe(1);
    expect(price(100, 0, 0)).toBe(1);
    expect(price(101, 0, 0)).toBe(2);
    expect(price(0, 3, 0)).toBe(3);
  });

  it("rounds payload bytes up per 100 MiB", () => {
    expect(price(0, 0, 1)).toBe(1);
    expect(price(0, 0, 100 * MIB)).toBe(1);
    expect(price(0, 0, 100 * MIB + 1)).toBe(2);
  });

  it("rounds each line once and reports the breakdown and price version", () => {
    expect(priceExtensionResourceUnits({ invocations: 250, jobUnits: 2, bytes: 150 * MIB })).toEqual({
      credits: 3 + 2 + 2,
      breakdown: { invocations: 3, jobUnits: 2, bytes: 2 },
      priceVersion: "ext-units-2026-11-25",
    });
    expect(priceExtensionResourceUnits({ invocations: 0, jobUnits: 0, bytes: 0 })).toEqual({
      credits: 0,
      breakdown: { invocations: 0, jobUnits: 0, bytes: 0 },
      priceVersion: "ext-units-2026-11-25",
    });
  });

  it("rejects negative, fractional, non-finite and non-numeric units", () => {
    expect(() => price(-1, 0, 0)).toThrow("invalid_resource_units");
    expect(() => price(0, 1.5, 0)).toThrow("invalid_resource_units");
    expect(() => price(0, 0, Number.NaN)).toThrow("invalid_resource_units");
    expect(() => price(Number.POSITIVE_INFINITY, 0, 0)).toThrow("invalid_resource_units");
    expect(() => priceExtensionResourceUnits({ invocations: "1" as unknown as number, jobUnits: 0, bytes: 0 })).toThrow("invalid_resource_units");
  });

  it("leaves the existing rate card unchanged", () => {
    expect(calculateResourceCredits("isolate_run", 100)).toBe(1);
    expect(calculateResourceCredits("workflow_step", 20)).toBe(1);
    expect(calculateResourceCredits("container_hour", 2)).toBe(10);
  });
});
