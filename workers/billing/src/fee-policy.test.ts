import { describe, expect, it } from "vitest";
import { normalizeFeeBps } from "./fee-policy.js";

describe("billing fee basis-point policy", () => {
  it("accepts whole-number values from zero through the full gross amount", () => {
    expect(normalizeFeeBps(0)).toBe(0);
    expect(normalizeFeeBps("500")).toBe(500);
    expect(normalizeFeeBps("10000")).toBe(10_000);
  });

  it.each(["-1", "10001", "500bps", " 500", "1.5", "", 10_001, Number.NaN, Infinity])(
    "uses a safe fallback for invalid value %s",
    (value) => expect(normalizeFeeBps(value, "250")).toBe(250)
  );

  it("uses the default when both the configured value and fallback are invalid", () => {
    expect(normalizeFeeBps("-3", "99999")).toBe(500);
  });
});
