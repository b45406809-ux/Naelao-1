import { afterEach, describe, expect, it, vi } from "vitest";
import { createWhopPlatformPlanCheckout } from "./whop-platform-plan.js";

describe("Whop platform-plan checkout boundary", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects insecure checkout URLs from Naelao platform-plan checkout", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ checkout_url: "http://whop.com/checkout" })));
    await expect(createWhopPlatformPlanCheckout("key", { planId: "plan_1", metadata: {} })).rejects.toThrow("valid HTTPS checkout url");
  });
});
