import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { registerGadgetMcpRoutes } from "./gadget-mcp.js";

describe("gadget MCP host adapter", () => {
  it("checks tenant ownership and routes only to the addressed space facet", async () => {
    const idFromName = vi.fn((name: string) => name as never);
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    const app = new Hono();
    registerGadgetMcpRoutes(app as never);
    const env = {
      PLATFORM_DB: { prepare: () => ({ bind: (...args: unknown[]) => ({ first: async () => args[0] === "s" && args[1] === "t" ? { 1: 1 } : null }) }) },
      MICRO_APP_DO: { idFromName, get: () => ({ fetch }) },
    } as never;

    const denied = await app.request("/spaces/s/apps/a/mcp", { method: "POST", headers: { "x-naelao-tenant-id": "wrong" } }, env);
    expect(denied.status).toBe(404);
    expect(idFromName).not.toHaveBeenCalled();

    const allowed = await app.request("/spaces/s/apps/a/mcp", { method: "POST", headers: { "x-naelao-tenant-id": "t" } }, env);
    expect(allowed.status).toBe(200);
    expect(idFromName).toHaveBeenCalledWith("gadget:a:space:s");
    expect(fetch).toHaveBeenCalledOnce();
  });
});
