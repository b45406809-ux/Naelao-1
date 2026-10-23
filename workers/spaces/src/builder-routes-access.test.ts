import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mintInternalToken } from "@naelao/http";
import { registerBuilderRoutes, type BuilderRoutesEnv } from "./builder-routes.js";

function appFor() {
  const app = new Hono();
  registerBuilderRoutes(app);
  return app;
}

function envFor(teamTenantId?: string): BuilderRoutesEnv {
  return {
    PLATFORM_SECRET: "test-platform-secret",
    NAELAO_DASHBOARD_TENANT_ID: teamTenantId,
    PLATFORM_DB: {
      prepare: () => ({
        bind: () => ({ first: async () => null }),
      }),
    },
  } as unknown as BuilderRoutesEnv;
}

async function teamHeaders(tenantId: string) {
  return {
    "x-naelao-tenant-id": tenantId,
    "x-naelao-internal-token": await mintInternalToken("test-platform-secret", tenantId),
    "x-naelao-role": "owner",
  };
}

describe("builder dashboard access boundary", () => {
  it("denies authenticated non-Naelao tenants across product and API-key routes", async () => {
    const app = appFor();
    const headers = await teamHeaders("customer-tenant");
    for (const path of ["/builder/launchpad", "/builder/products", "/builder/api-keys"]) {
      const response = await app.request(path, { headers }, envFor("naelao-team"));
      expect(response.status, path).toBe(403);
      expect((await response.json()).error_code).toBe("forbidden");
    }
  });

  it("fails closed when the Naelao dashboard tenant is not configured", async () => {
    const response = await appFor().request("/builder/launchpad", {
      headers: await teamHeaders("naelao-team"),
    }, envFor());
    expect(response.status).toBe(403);
  });

  it("denies ordinary team members administrative dashboard access", async () => {
    const headers = await teamHeaders("naelao-team");
    headers["x-naelao-role"] = "member";
    const response = await appFor().request("/builder/launchpad", { headers }, envFor("naelao-team"));
    expect(response.status).toBe(403);
  });

  it("allows the configured Naelao tenant to read its singleton Launchpad surface", async () => {
    const response = await appFor().request("/builder/launchpad", {
      headers: await teamHeaders("naelao-team"),
    }, envFor("naelao-team"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ product: null, can_initialize: true });
  });
});
