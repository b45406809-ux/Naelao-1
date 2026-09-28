import { describe, expect, it } from "vitest";
import { calculateResourceCredits, CREDITS_PER_USD, tokensToCredits } from "./credits.js";

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
});
