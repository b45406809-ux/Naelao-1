import { describe, expect, it, vi } from "vitest";
import spacesWorker from "../../workers/spaces/src/index.js";
import { mintInternalToken } from "@naelao/http";

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const secret = "test-platform-secret";

async function request(path: string, method = "GET") {
  const prepare = vi.fn();
  const response = await spacesWorker.fetch(new Request(`https://spaces.naelao.com${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-naelao-tenant-id": "external-tenant",
      "x-naelao-internal-token": await mintInternalToken(secret, "external-tenant"),
    },
    ...(method === "POST" || method === "PATCH" ? { body: "{}" } : {}),
  }), {
    PLATFORM_SECRET: secret,
    NAELAO_DASHBOARD_TENANT_ID: "naelao-team",
    PLATFORM_DB: { prepare },
  } as never, execCtx);
  return { response, prepare };
}

describe("removed product commerce and personal-plan host routes", () => {
  it.each([
    ["GET", "/spaces/space-1/pricing"],
    ["GET", "/spaces/space-1/personal-plan"],
    ["GET", "/internal/pricing-catalog?space_id=space-1"],
    ["POST", "/internal/credit-packs/grant"],
    ["POST", "/internal/personal-plan/grant"],
  ])("keeps %s %s unavailable", async (method, path) => {
    const { response, prepare } = await request(path, method);
    expect(response.status).toBe(404);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("restricts product-pricing administration to the Naelao team and performs no external billing writes", async () => {
    const { response, prepare } = await request("/builder/products/product-1/pricing", "PATCH");
    expect(response.status).toBe(403);
    expect(prepare).not.toHaveBeenCalled();
  });
});
