import type { Context, Hono } from "hono";
import type { Env } from "../index.js";
import { gadgetActorId } from "../do/MicroAppDO.js";

export function registerGadgetMcpRoutes(app: Hono<{ Bindings: Env }>): void {
  const forward = async (c: Context<{ Bindings: Env }>, path: string, method = c.req.method, bodyOverride?: ArrayBuffer) => {
    const tenantId = c.req.header("x-naelao-tenant-id");
    if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
    const { spaceId, appId } = c.req.param();
    if (!spaceId || !appId || !/^[a-z][a-z0-9_-]{1,63}$/.test(appId)) return c.json({ error_code: "bad_request", message: "Invalid gadget identity" }, 400);
    const owned = await c.env.PLATFORM_DB.prepare("SELECT 1 FROM spaces WHERE id = ? AND tenant_id = ? AND status != 'deleted'").bind(spaceId, tenantId).first();
    if (!owned) return c.json({ error_code: "not_found", message: "Space or app not found" }, 404);
    const role = c.req.header("x-naelao-role") ?? "viewer";
    if (!["owner", "admin"].includes(role)) {
      const userId = c.req.header("x-naelao-user-id");
      if (!userId) return c.json({ error_code: "forbidden", message: "Space membership required" }, 403);
      const member = await c.env.PLATFORM_DB.prepare(
        "SELECT 1 FROM space_members WHERE space_id = ? AND tenant_id = ? AND end_user_id = ? AND suspended_at IS NULL"
      ).bind(spaceId, tenantId, userId).first();
      if (!member) return c.json({ error_code: "forbidden", message: "Space membership required" }, 403);
    }
    const id = gadgetActorId(c.env.MICRO_APP_DO, { scope: "SPACE_WIDE", spaceId, appId });
    const request = new Request(`http://micro-app${path}`, {
      method,
      headers: c.req.raw.headers,
      ...(method === "POST" ? { body: bodyOverride ?? await c.req.arrayBuffer() } : {}),
    });
    return c.env.MICRO_APP_DO.get(id).fetch(request);
  };
  app.post("/spaces/:spaceId/apps/:appId/mcp", c => forward(c, "/mcp"));
  app.get("/spaces/:spaceId/apps/:appId/app", c => forward(c, "/app", "GET"));
  app.get("/spaces/:spaceId/apps/:appId/api/data", c => forward(c, `/api/data${new URL(c.req.url).search}`, "GET"));
  app.post("/spaces/:spaceId/apps/:appId/api/data", c => forward(c, "/api/data"));
  app.delete("/spaces/:spaceId/apps/:appId/api/data", c => forward(c, `/api/data${new URL(c.req.url).search}`, "DELETE"));
  app.post("/spaces/:spaceId/apps/:appId/initialize", async c => {
    if (!["owner", "admin"].includes(c.req.header("x-naelao-role") ?? "")) return c.json({ error_code: "forbidden", message: "Space administrator required" }, 403);
    const bytes = await c.req.arrayBuffer();
    let body: { appId?: unknown; scope?: unknown; gadgetTier?: unknown };
    try { body = JSON.parse(new TextDecoder().decode(bytes)) as typeof body; }
    catch { return c.json({ error_code: "bad_request", message: "Invalid initialization payload" }, 400); }
    if (body.appId !== c.req.param("appId") || body.scope !== "SPACE_SHARED" || body.gadgetTier !== 3) {
      return c.json({ error_code: "bad_request", message: "Only the named SPACE_SHARED tier-3 gadget can be installed on this route" }, 400);
    }
    return forward(c, "/initialize", "POST", bytes);
  });
}
