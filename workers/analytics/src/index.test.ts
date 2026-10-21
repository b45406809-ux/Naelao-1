import { mintInternalToken } from "@naelao/http";
import { describe, expect, it, vi } from "vitest";
import worker from "./index";

function environment() {
  const first = vi.fn(async () => null);
  const cacheGet = vi.fn(async () => null);
  const prepare = vi.fn((sql: string) => ({
    bind: (..._values: unknown[]) => ({ first }),
  }));
  return {
    env: {
      PLATFORM_SECRET: "secret",
      PLATFORM_DB: { prepare },
      METRICS_CACHE: { get: cacheGet, put: vi.fn() },
      CF_ACCOUNT_ID: "account",
      CF_ANALYTICS_API_TOKEN: "token",
    } as never,
    prepare,
    first,
    cacheGet,
  };
}

describe("analytics tenant suspension gates", () => {
  it("rejects a suspended Space before reading cached space metrics", async () => {
    const fixture = environment();
    const token = await mintInternalToken("secret", "tenant");
    const response = await worker.fetch(new Request("https://analytics/metrics/space/space", {
      headers: { "x-naelao-tenant-id": "tenant", "x-naelao-internal-token": token },
    }), fixture.env, {} as ExecutionContext);
    expect(response.status).toBe(404);
    expect(fixture.prepare.mock.calls[0]?.[0]).toContain("o.status = 'active'");
    expect(fixture.cacheGet).not.toHaveBeenCalled();
  });

  it("rejects a suspended tenant before reading cached tenant metrics", async () => {
    const fixture = environment();
    const response = await worker.fetch(new Request("https://analytics/metrics/tenant", {
      headers: { "x-naelao-tenant-id": "tenant" },
    }), fixture.env, {} as ExecutionContext);
    expect(response.status).toBe(404);
    expect(fixture.prepare.mock.calls[0]?.[0]).toContain("status = 'active'");
    expect(fixture.cacheGet).not.toHaveBeenCalled();
  });
});
