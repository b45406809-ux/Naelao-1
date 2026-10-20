import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { registerBusinessRoutes } from "./business-routes.js";

function routeApp() {
  const app = new Hono();
  registerBusinessRoutes(app);
  return app;
}

describe("customer business creation route identity", () => {
  it("rejects forged identity headers before reading product data", async () => {
    const first = vi.fn();
    const env = { PLATFORM_SECRET: "secret", PLATFORM_DB: { prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first })) })) } } as never;
    const response = await routeApp().request("/spaces/product-1/businesses", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "user-a", "x-naelao-role": "product_end_user" },
      body: JSON.stringify({ name: "Business", spacetype_id: "launchpad" }),
    }, env);
    expect(response.status).toBe(403);
    expect(first).not.toHaveBeenCalled();
  });

  it("rejects a signed user session from a different product tenant", async () => {
    const env = {
      PLATFORM_SECRET: "secret",
      PLATFORM_DB: { prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first: vi.fn(async () => ({ tenant_id: "tenant-real" })) })) })) },
    } as never;
    const response = await routeApp().request("/spaces/product-1/businesses", {
      method: "POST", headers: {
        "content-type": "application/json", "x-naelao-tenant-id": "tenant-other", "x-naelao-user-id": "user-a", "x-naelao-role": "product_end_user",
        "x-naelao-internal-token": await mintInternalToken("secret", "tenant-other"),
      }, body: JSON.stringify({ name: "Business", spacetype_id: "launchpad" }),
    }, env);
    expect(response.status).toBe(404);
  });
});
