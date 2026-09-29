import type { Hono } from "hono";
import type { Env } from "../index.js";
import { gadgetActorId } from "../do/MicroAppDO.js";

export function registerGadgetMcpRoutes(app: Hono<{ Bindings: Env }>): void {
  app.post("/spaces/:spaceId/apps/:appId/mcp", async c => {
    const tenantId = c.req.header("x-naelao-tenant-id");
    if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
    const { spaceId, appId } = c.req.param();
    const owned = await c.env.PLATFORM_DB.prepare("SELECT 1 FROM spaces WHERE id = ? AND tenant_id = ? AND status != 'deleted'").bind(spaceId, tenantId).first();
    if (!owned) return c.json({ error_code: "not_found", message: "Space or app not found" }, 404);
    const id = gadgetActorId(c.env.MICRO_APP_DO, { scope: "SPACE_WIDE", spaceId, appId });
    // Buffer this small JSON-RPC turn rather than forwarding a runtime-specific ReadableStream;
    // it keeps the DO hop portable and prevents stream ownership/duplex issues.
    const body = await c.req.raw.arrayBuffer();
    return c.env.MICRO_APP_DO.get(id).fetch(new Request("http://micro-app/mcp", { method: "POST", headers: c.req.raw.headers, body }));
  });
}
