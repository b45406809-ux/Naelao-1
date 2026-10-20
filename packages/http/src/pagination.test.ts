import { describe, expect, it } from "vitest";
import { parseBoundedInteger } from "./pagination.js";

describe("parseBoundedInteger", () => {
  it("uses fallback for missing, malformed, fractional, and unsafe values", () => {
    for (const value of [null, undefined, "", "  ", "1.5", "1e3", "NaN", "Infinity", "9007199254740992", "+2"]) {
      expect(parseBoundedInteger(value, 20, 1, 100)).toBe(20);
    }
  });

  it("trims valid decimal integers and clamps both ends", () => {
    expect(parseBoundedInteger(" 7 ", 20, 1, 100)).toBe(7);
    expect(parseBoundedInteger("-9", 20, 1, 100)).toBe(1);
    expect(parseBoundedInteger("999", 20, 1, 100)).toBe(100);
    expect(parseBoundedInteger("-9", 0, 0, 100)).toBe(0);
  });

  it("rejects invalid bounds instead of silently producing an unsafe fallback", () => {
    expect(() => parseBoundedInteger("5", Number.NaN, 1, 10)).toThrow("invalid_integer_bounds");
    expect(() => parseBoundedInteger("5", 0, 1, 10)).toThrow("invalid_integer_bounds");
    expect(() => parseBoundedInteger("5", 5, 10, 1)).toThrow("invalid_integer_bounds");
  });
});
