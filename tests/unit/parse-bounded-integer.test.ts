import { describe, expect, it } from "vitest";
import { parseBoundedInteger } from "../../packages/http/src/pagination.js";

describe("bounded query integers", () => {
  it("clamps both extremes before a value reaches a database limit", () => {
    expect(parseBoundedInteger("-1", 50, 1, 200)).toBe(1);
    expect(parseBoundedInteger("999999999", 50, 1, 200)).toBe(200);
  });

  it("uses the finite fallback for malformed or unsafe values", () => {
    expect(parseBoundedInteger("NaN", 50, 1, 200)).toBe(50);
    expect(parseBoundedInteger("1.5", 50, 1, 200)).toBe(50);
    expect(parseBoundedInteger("9007199254740992", 50, 1, 200)).toBe(50);
    expect(parseBoundedInteger(null, 0, 0, 100_000)).toBe(0);
  });

  it("rejects invalid ranges instead of silently creating an unbounded query", () => {
    expect(() => parseBoundedInteger("1", 0, 1, 200)).toThrow(
      "invalid_integer_bounds"
    );
    expect(() => parseBoundedInteger("1", 1, 10, 5)).toThrow(
      "invalid_integer_bounds"
    );
  });
});
