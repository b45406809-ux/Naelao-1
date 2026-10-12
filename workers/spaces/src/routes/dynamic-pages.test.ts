import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { registerDynamicPageRoutes } from "./dynamic-pages.js";

function harness(suffix = "preview.test", applicationSuffix = "app.test") {
  const idFromName = vi.fn((name: string) => name as never);
  const fetch = vi.fn(async (request: Request) => Response.json({ path: new URL(request.url).pathname, method: request.method }));
  const app = new Hono();
  registerDynamicPageRoutes(app as never);
  const env = {
    DYNAMIC_PAGE_HOST_SUFFIX: suffix,
    APPLICATION_HOST_SUFFIX: applicationSuffix,
    PLATFORM_DB: { prepare: () => ({ bind: (...args: unknown[]) => ({ first: async () => args[0] === "s" ? { tenant_id: "tenant-a" } : null }) }) },
    MICRO_APP_DO: { idFromName, get: () => ({ fetch }) },
  } as never;
  return { app, env, idFromName, fetch };
}

describe("dynamic page isolation boundary", () => {
  it("restricts publication to a tenant's space administrators", async () => {
    const h = harness();
    const path = "/spaces/s/apps/app/pages";
    const denied = await h.app.request(path, { method: "POST", headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-role": "member" }, body: "{}" }, h.env);
    expect(denied.status).toBe(403);
    const allowed = await h.app.request(path, { method: "POST", headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-role": "owner" }, body: "{}" }, h.env);
    expect(await allowed.json()).toEqual({ path: "/page/publish", method: "POST" });
    expect(h.fetch).toHaveBeenCalledOnce();
  });

  it("serves a page only from that tenant's dedicated preview origin", async () => {
    const h = harness();
    const denied = await h.app.request("https://app.example.test/p/s/app/sign", undefined, h.env);
    expect(denied.status).toBe(404);
    expect(h.fetch).not.toHaveBeenCalled();
    const allowed = await h.app.request("https://tenant-a.preview.test/p/s/app/sign", undefined, h.env);
    expect(await allowed.json()).toEqual({ path: "/page/render", method: "GET" });
    expect(h.idFromName).toHaveBeenCalledWith("gadget:app:space:s");
  });

  it("requires a same-origin POST for the public form action", async () => {
    const h = harness();
    const path = "https://tenant-a.preview.test/p/s/app/sign/actions/submit";
    const denied = await h.app.request(path, { method: "POST", headers: { origin: "https://attacker.test" }, body: "{}" }, h.env);
    expect(denied.status).toBe(403);
    const allowed = await h.app.request(path, { method: "POST", headers: { origin: "https://tenant-a.preview.test" }, body: "{}" }, h.env);
    expect(await allowed.json()).toEqual({ path: "/page/action", method: "POST" });
  });

  it("keeps pages disabled without a dedicated origin configuration", async () => {
    const h = harness("");
    const response = await h.app.request("https://tenant-a.preview.test/p/s/app/sign", undefined, h.env);
    expect(response.status).toBe(503);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("rejects a preview suffix beneath the application cookie domain", async () => {
    const h = harness("preview.app.test", "app.test");
    const response = await h.app.request("https://tenant-a.preview.app.test/p/s/app/sign", undefined, h.env);
    expect(response.status).toBe(503);
    expect(h.fetch).not.toHaveBeenCalled();
  });
});
