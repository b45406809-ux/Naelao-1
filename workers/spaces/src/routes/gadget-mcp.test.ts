import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { registerGadgetMcpRoutes } from "./gadget-mcp.js";

describe("gadget MCP host adapter", () => {
  it("checks tenant ownership before routing app, storage, and MCP requests", async () => {
    const idFromName = vi.fn((name: string) => name as never);
    const fetch = vi.fn(async (request: Request) => Response.json({ path: new URL(request.url).pathname, method: request.method }));
    const app = new Hono();
    registerGadgetMcpRoutes(app as never);
    const env = {
      PLATFORM_DB: { prepare: () => ({ bind: (...args: unknown[]) => ({ first: async () => args[0] === "s" && args[1] === "t" ? { 1: 1 } : null }) }) },
      MICRO_APP_DO: { idFromName, get: () => ({ fetch }) },
    } as never;

    const denied = await app.request("/spaces/s/apps/app/mcp", { method: "POST", headers: { "x-naelao-tenant-id": "wrong" } }, env);
    expect(denied.status).toBe(404);
    expect(idFromName).not.toHaveBeenCalled();

    const allowed = await app.request("/spaces/s/apps/app/mcp", { method: "POST", headers: { "x-naelao-tenant-id": "t", "x-naelao-role": "admin" } }, env);
    expect(await allowed.json()).toEqual({ path: "/mcp", method: "POST" });
    expect(idFromName).toHaveBeenCalledWith("gadget:app:space:s");
    expect(fetch).toHaveBeenCalledOnce();

    const page = await app.request("/spaces/s/apps/app/app", { headers: { "x-naelao-tenant-id": "t", "x-naelao-role": "admin" } }, env);
    expect(await page.json()).toEqual({ path: "/app", method: "GET" });
    const data = await app.request("/spaces/s/apps/app/api/data?key=x", { headers: { "x-naelao-tenant-id": "t", "x-naelao-role": "admin" } }, env);
    expect(await data.json()).toEqual({ path: "/api/data", method: "GET" });
    const deniedPage = await app.request("/spaces/s/apps/app/app", { headers: { "x-naelao-tenant-id": "wrong", "x-naelao-role": "admin" } }, env);
    expect(deniedPage.status).toBe(404);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("requires an administrator to initialize a gadget", async () => {
    const app = new Hono();
    registerGadgetMcpRoutes(app as never);
    const env = {
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ 1: 1 }) }) }) },
      MICRO_APP_DO: { idFromName: (name: string) => name as never, get: () => ({ fetch: async () => Response.json({ ok: true }) }) },
    } as never;
    const denied = await app.request("/spaces/s/apps/app/initialize", { method: "POST", headers: { "x-naelao-tenant-id": "t", "x-naelao-role": "member" }, body: "{}" }, env);
    expect(denied.status).toBe(403);
    const invalidScope = await app.request("/spaces/s/apps/app/initialize", { method: "POST", headers: { "x-naelao-tenant-id": "t", "x-naelao-role": "admin" }, body: JSON.stringify({ appId: "app", scope: "SPACE_WIDE", gadgetTier: 3 }) }, env);
    expect(invalidScope.status).toBe(400);
    const allowed = await app.request("/spaces/s/apps/app/initialize", { method: "POST", headers: { "x-naelao-tenant-id": "t", "x-naelao-role": "admin" }, body: JSON.stringify({ appId: "app", scope: "SPACE_SHARED", gadgetTier: 3 }) }, env);
    expect(allowed.status).toBe(200);
  });

  it("requires active space membership for non-admin gadget access", async () => {
    const app = new Hono();
    registerGadgetMcpRoutes(app as never);
    const prepare = vi.fn((query: string) => ({ bind: (...args: unknown[]) => ({ first: async () => query.includes("space_members") ? (args[2] === "active-member" ? { 1: 1 } : null) : { 1: 1 } }) }));
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    const env = { PLATFORM_DB: { prepare }, MICRO_APP_DO: { idFromName: (name: string) => name as never, get: () => ({ fetch }) } } as never;
    const denied = await app.request("/spaces/s/apps/app/mcp", { method: "POST", headers: { "x-naelao-tenant-id": "t", "x-naelao-user-id": "suspended", "x-naelao-role": "member" } }, env);
    expect(denied.status).toBe(403);
    const allowed = await app.request("/spaces/s/apps/app/mcp", { method: "POST", headers: { "x-naelao-tenant-id": "t", "x-naelao-user-id": "active-member", "x-naelao-role": "member" } }, env);
    expect(allowed.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
