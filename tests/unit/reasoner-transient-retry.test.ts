import { describe, it, expect } from "vitest";
import { retryDelayMs } from "../../workers/agents/src/script-engine/reasoner.js";

/**
 * Free-tier providers rate-limit on a rolling window and usually say exactly how long to wait.
 * Discarding that and failing the whole run is what made a multi-step autonomous run impossible
 * on a free tier: an agent payload of ~9k tokens against Groq's 12k tokens-per-minute ceiling is
 * roughly one call per minute, so the loop died on its second call, four spaced attempts running.
 */
const H = (h: Record<string, string> = {}) => new Headers(h);

describe("retryDelayMs — wait when waiting actually fixes it", () => {
  it("honours the provider's own stated wait, from the live Groq message", () => {
    const body =
      'Rate limit reached for model `llama-3.3-70b-versatile` … on tokens per minute (TPM): ' +
      "Limit 12000, Used 8664, Requested 8879. Please try again in 27.715s.";
    const ms = retryDelayMs(429, H(), body, 0);
    // Just past the stated boundary, never short of it — retrying early just burns another 429.
    expect(ms).toBeGreaterThanOrEqual(27_715);
    expect(ms).toBeLessThan(29_000);
  });

  it("prefers a Retry-After header over anything parsed from prose", () => {
    expect(retryDelayMs(429, H({ "retry-after": "3" }), "try again in 99s", 0)).toBe(3_500);
  });

  it("backs off on an overloaded provider that gives no number", () => {
    const body = "This model is currently experiencing high demand. Please try again later.";
    expect(retryDelayMs(503, H(), body, 0)).toBe(2_500);
    expect(retryDelayMs(503, H(), body, 1)).toBe(4_500);
  });

  it("does NOT wait for a daily allowance — it cannot come back inside this run", () => {
    const gemini =
      "You exceeded your current quota. * Quota exceeded for metric: " +
      "generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 15";
    expect(retryDelayMs(429, H(), gemini, 0)).toBeUndefined();
    expect(retryDelayMs(429, H(), "you have used up your daily free allocation of 10,000 neurons", 0))
      .toBeUndefined();
  });

  it("still waits on a daily-sounding body when the provider sent a real Retry-After", () => {
    // The header is the provider speaking precisely; prose heuristics must not override it.
    expect(retryDelayMs(429, H({ "retry-after": "5" }), "daily limit reached", 0)).toBe(5_500);
  });

  it("never holds a run open for an unbounded wait", () => {
    expect(retryDelayMs(429, H({ "retry-after": "600" }), "", 0)).toBeUndefined();
  });

  it("does not retry anything that waiting cannot fix", () => {
    for (const status of [400, 401, 403, 404, 500]) {
      expect(retryDelayMs(status, H(), "Model not found", 0)).toBeUndefined();
    }
  });
});
