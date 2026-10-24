import { describe, expect, it, vi } from "vitest";
import spacesWorker from "../../workers/spaces/src/index.js";
import { mintInternalToken } from "@naelao/http";

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const secret = "test-platform-secret";

async function request(path: string, method = "GET") {
  return spacesWorker.fetch(new Request(`https://spaces.naelao.com${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-naelao-tenant-id": "external-tenant",
      "x-naelao-internal-token": await mintInternalToken(secret, "external-tenant"),
    },
    ...(method === "POST" ? { body: "{}" } : {}),
  }), {
    PLATFORM_SECRET: secret,
    NAELAO_DASHBOARD_TENANT_ID: "naelao-team",
    PLATFORM_DB: { prepare: vi.fn() },
  } as never, execCtx);
}

describe("retired general builder payout API", () => {
  it.each([
    ["GET", "/builder/payouts/balance"],
    ["GET", "/builder/payouts"],
    ["POST", "/builder/payouts/request"],
  ])("does not expose %s %s to ordinary Space tenants", async (method, path) => {
    const response = await request(path, method);
    expect(response.status).toBe(403);
  });

  it("does not expose the legacy payout fulfillment route", async () => {
    const response = await request("/internal/payout-requests/request-1/fulfill", "POST");
    expect(response.status).toBe(404);
  });
});
