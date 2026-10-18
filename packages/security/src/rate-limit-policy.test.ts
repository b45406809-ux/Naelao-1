import { describe, expect, it } from "vitest";
import { isValidRateLimitRequest } from "./rate-limit-policy.js";

describe("rate limiter request validation", () => {
  it("accepts valid limits and the configured maximums", () => {
    expect(
      isValidRateLimitRequest({ key: "tenant:a", limit: 100, windowMs: 60_000 })
    ).toBe(true);
    expect(
      isValidRateLimitRequest({ limit: 100_000, windowMs: 86_400_000 })
    ).toBe(true);
  });

  it("rejects values that can bypass or retain unbounded rate-limit state", () => {
    for (const request of [
      null,
      [],
      { limit: 0, windowMs: 60_000 },
      { limit: 1.5, windowMs: 60_000 },
      { limit: Number.POSITIVE_INFINITY, windowMs: 60_000 },
      { limit: 100_001, windowMs: 60_000 },
      { limit: 1, windowMs: 999 },
      { limit: 1, windowMs: 86_400_001 },
      { limit: 1, windowMs: 60_000, key: "x".repeat(257) },
    ]) {
      expect(isValidRateLimitRequest(request)).toBe(false);
    }
  });
});
