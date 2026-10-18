import { describe, expect, it, vi } from "vitest";
import worker from "./index.js";

function env(limiterResponse: Response) {
  const limiterFetch = vi.fn(async () => limiterResponse);
  const rateLimiter = {
    idFromName: vi.fn((name: string) => name as unknown as DurableObjectId),
    get: vi.fn(() => ({ fetch: limiterFetch })),
  } as unknown as DurableObjectNamespace;
  const routerFetch = vi.fn(
    async () => new Response("upstream", { status: 200 })
  );
  return {
    bindings: {
      ENVIRONMENT: "test",
      PLATFORM_SECRET: "test-secret",
      PLATFORM_DB: {} as D1Database,
      RATE_LIMITER: rateLimiter,
      ROUTER_WORKER: { fetch: routerFetch } as unknown as Fetcher,
      RATE_LIMIT_GLOBAL: "1000",
      RATE_LIMIT_AUTH: "10",
      RATE_LIMIT_TENANT: "500",
    },
    limiterFetch,
    routerFetch,
    rateLimiter,
  };
}

describe("security gateway limiter boundary", () => {
  it("applies the global limiter to private-looking connecting IPs", async () => {
    const mocks = env(Response.json({ allowed: true }));
    const response = await worker.fetch(
      new Request("https://gateway.test/v1/data", {
        headers: { "cf-connecting-ip": "127.0.0.1" },
      }),
      mocks.bindings,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect(mocks.rateLimiter.idFromName).toHaveBeenCalledWith(
      "rl:ip:127.0.0.1"
    );
    expect(mocks.routerFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    new Response("unavailable", { status: 503 }),
    new Response("not-json", { status: 200 }),
    Response.json({ allowed: "yes" }),
    Response.json({ allowed: true, retryAfterMs: Number.NaN }),
  ])(
    "fails closed when the rate limiter response is invalid",
    async (limiterResponse) => {
      const mocks = env(limiterResponse);
      const response = await worker.fetch(
        new Request("https://gateway.test/v1/data"),
        mocks.bindings,
        {} as ExecutionContext
      );

      expect(response.status).toBe(429);
      expect(mocks.routerFetch).not.toHaveBeenCalled();
    }
  );
});
