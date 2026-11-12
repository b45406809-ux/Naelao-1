import { describe, expect, it } from "vitest";
import { isDevelopmentCheckoutAllowed } from "./checkout-policy.js";

describe("development checkout policy", () => {
  it("requires an explicit local development opt-in", () => {
    expect(isDevelopmentCheckoutAllowed({ environment: "development", allowDevCheckouts: "true" })).toBe(true);
    expect(isDevelopmentCheckoutAllowed({ environment: "test", allowDevCheckouts: "true" })).toBe(true);
    expect(isDevelopmentCheckoutAllowed({ environment: "development" })).toBe(false);
    expect(isDevelopmentCheckoutAllowed({ environment: "development", allowDevCheckouts: "TRUE" })).toBe(false);
  });

  it("never allows simulated checkout in staging or production", () => {
    expect(isDevelopmentCheckoutAllowed({ environment: "staging", allowDevCheckouts: "true" })).toBe(false);
    expect(isDevelopmentCheckoutAllowed({ environment: "production", allowDevCheckouts: "true" })).toBe(false);
  });
});
