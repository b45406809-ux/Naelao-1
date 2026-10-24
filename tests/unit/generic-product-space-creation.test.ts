import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { registerBusinessRoutes } from "../../workers/spaces/src/business-routes.js";

describe("generic product Space creation boundary", () => {
  it("exposes the generic /spaces route only to a verified product-user identity", async () => {
    const prepare = vi.fn();
    const app = new Hono();
    registerBusinessRoutes(app);

    const response = await app.request("/spaces/product-root/spaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "My Space" }),
    }, {
      PLATFORM_DB: { prepare } as never,
      PLATFORM_SECRET: "test-secret",
      SPACE_DO: {} as never,
    } as never);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error_code: "forbidden" });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("does not expose the removed business-creation route", async () => {
    const app = new Hono();
    registerBusinessRoutes(app);
    const response = await app.request("/spaces/product-root/businesses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "My Business" }),
    }, {
      PLATFORM_DB: { prepare: vi.fn() } as never,
      PLATFORM_SECRET: "test-secret",
      SPACE_DO: {} as never,
    } as never);

    expect(response.status).toBe(404);
  });
});
