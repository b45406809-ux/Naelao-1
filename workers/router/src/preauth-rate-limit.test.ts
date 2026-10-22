import { describe, expect, it, vi } from "vitest";
import { checkPreAuthRateLimit, type Env } from "./index.js";

describe("pre-auth rate limiting", () => {
  it("fails closed when the limiter binding is missing", async () => {
    const result = await checkPreAuthRateLimit({
      env: {} as Env,
      req: { header: () => "203.0.113.7" },
    }, "login", 10);
    expect(result).toEqual({ allowed: false, retryAfterMs: 30_000 });
  });

  it("fails closed when the limiter service is unavailable", async () => {
    const get = vi.fn(() => ({ fetch: vi.fn(async () => { throw new Error("DO unavailable"); }) }));
    const result = await checkPreAuthRateLimit({
      env: { RATE_LIMIT_DO: { idFromName: () => ({}), get } } as unknown as Env,
      req: { header: () => "203.0.113.7" },
    }, "signup", 5);
    expect(result).toEqual({ allowed: false, retryAfterMs: 30_000 });
  });
});
