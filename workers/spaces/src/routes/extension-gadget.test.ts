import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mintInternalToken } from "@naelao/http";
import { registerExtensionGadgetRoutes } from "./extension-gadget.js";

describe("extension workflow Gadget bridge", () => {
  it("forwards only a declared Gadget operation to the exact named project install", async () => {
    let rpc: Record<string, unknown> | null = null;
    const spaceStub = { fetch: vi.fn(async () => new Response(JSON.stringify({
      instance: { instance_id: "install-a", tenant_id: "tenant-a", space_id: "space-a", project_id: "project-a", instance_key: "mentor2", status: "active", scope: "PROJECT_BOUND" },
      manifest: { id: "ext_mentor", bundle: { id: "ext_mentor", version: "1.0.0", primitives: [{ id: "journal", kind: "gadget" }] } },
    }), { headers: { "content-type": "application/json" } })) };
    const env = {
      PLATFORM_SECRET: "test-secret",
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ id: "space-a" }) }) }) },
      SPACE_DO: { idFromName: () => "space-do", get: () => spaceStub },
      MICRO_APP_DO: { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => {
        rpc = await request.json() as Record<string, unknown>;
        return Response.json({ jsonrpc: "2.0", id: "1", result: { structuredContent: { inserted: true } } });
      } }) },
    };
    const app = new Hono(); registerExtensionGadgetRoutes(app as never);
    const token = await mintInternalToken(env.PLATFORM_SECRET, "tenant-a");
    const response = await app.request("/spaces/space-a/internal/extensions/install-a/gadgets/journal/insert", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token },
      body: JSON.stringify({ project_id: "project-a", arguments: { table: "orders", record: { id: "one" } } }),
    }, env as never);
    expect(response.status).toBe(200);
    expect(rpc).toMatchObject({ method: "tools/call", params: { name: "app_mentor2_journal_insert", arguments: { table: "orders", record: { id: "one" } } } });
    expect(spaceStub.fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects wrong-project and undeclared Gadget requests without touching the actor", async () => {
    const spaceStub = { fetch: vi.fn(async () => Response.json({
      instance: { instance_id: "install-a", tenant_id: "tenant-a", space_id: "space-a", project_id: "project-a", instance_key: "default", status: "active", scope: "PROJECT_BOUND" },
      manifest: { id: "ext_mentor", bundle: { id: "ext_mentor", version: "1.0.0", primitives: [{ id: "journal", kind: "gadget" }] } },
    })) };
    const actorFetch = vi.fn(async () => Response.json({}));
    const env = { PLATFORM_SECRET: "test-secret", PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ id: "space-a" }) }) }) },
      SPACE_DO: { idFromName: () => "space-do", get: () => spaceStub }, MICRO_APP_DO: { idFromName: (name: string) => name, get: () => ({ fetch: actorFetch }) } };
    const app = new Hono(); registerExtensionGadgetRoutes(app as never);
    const token = await mintInternalToken(env.PLATFORM_SECRET, "tenant-a"), headers = { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token };
    const wrongProject = await app.request("/spaces/space-a/internal/extensions/install-a/gadgets/journal/list", { method: "POST", headers, body: JSON.stringify({ project_id: "project-b", arguments: { table: "orders" } }) }, env as never);
    expect(wrongProject.status).toBe(403);
    const wrongGadget = await app.request("/spaces/space-a/internal/extensions/install-a/gadgets/private_data/list", { method: "POST", headers, body: JSON.stringify({ project_id: "project-a", arguments: { table: "orders" } }) }, env as never);
    expect(wrongGadget.status).toBe(403);
    expect(actorFetch).not.toHaveBeenCalled();
  });
});
