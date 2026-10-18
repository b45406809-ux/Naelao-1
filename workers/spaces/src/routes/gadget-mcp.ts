import type { Context, Hono } from "hono";
import type { Env } from "../index.js";
import { gadgetActorId } from "../do/MicroAppDO.js";
import { getDOName } from "@naelao/crypto";

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
  app.get("/spaces/:spaceId/apps/:appId/api/storage", c => forward(c, "/api/storage", "GET"));
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

  const projectAccess = async (c: Context<{ Bindings: Env }>, write: boolean): Promise<Response | null> => {
    const tenantId = c.req.header("x-naelao-tenant-id") ?? "", role = c.req.header("x-naelao-role") ?? "viewer";
    const { spaceId = "", projectId = "" } = c.req.param();
    const userId = c.req.header("x-naelao-user-id") ?? "";
    if (!tenantId || !spaceId || !projectId || !/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) return c.json({ error_code: "bad_request" }, 400);
    if (write && !["owner", "admin"].includes(role)) return c.json({ error_code: "forbidden", message: "Space administrator required" }, 403);
    if (role !== "owner" && role !== "admin") {
      if (!userId) return c.json({ error_code: "forbidden", message: "Project membership required" }, 403);
      const member = await c.env.PLATFORM_DB.prepare("SELECT 1 FROM space_members WHERE space_id=? AND tenant_id=? AND end_user_id=? AND suspended_at IS NULL").bind(spaceId, tenantId, userId).first();
      if (!member) return c.json({ error_code: "forbidden", message: "Space membership required" }, 403);
    }
    const owned = await c.env.PLATFORM_DB.prepare("SELECT 1 FROM spaces WHERE id=? AND tenant_id=? AND status!='deleted'").bind(spaceId, tenantId).first();
    if (!owned) return c.json({ error_code: "not_found" }, 404);
    const id = c.env.SPACE_DO.idFromName(await getDOName("space", spaceId, tenantId, c.env.PLATFORM_SECRET));
    const viewer = ["owner", "admin"].includes(role) ? "space_manager=1" : `viewer_id=${encodeURIComponent(userId)}`;
    const project = await c.env.SPACE_DO.get(id).fetch(new Request(`http://space-do/projects/${encodeURIComponent(projectId)}?${viewer}`));
    if (!project.ok) return c.json({ error_code: project.status === 404 ? "not_found" : "forbidden" }, project.status === 404 ? 404 : 403);
    return null;
  };
  const forwardProject = async (c: Context<{ Bindings: Env }>, path: string, method = c.req.method, override?: ArrayBuffer) => {
    const blocked = await projectAccess(c, method !== "GET");
    if (blocked) return blocked;
    const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
    const { spaceId = "", projectId = "", appId = "" } = c.req.param();
    if (!appId || !/^[a-z][a-z0-9_-]{1,63}$/.test(appId)) return c.json({ error_code: "bad_request" }, 400);
    const spaceDoId = c.env.SPACE_DO.idFromName(await getDOName("space", spaceId, tenantId, c.env.PLATFORM_SECRET));
    const runtime = await c.env.SPACE_DO.get(spaceDoId).fetch(new Request(`http://space-do/project-extension-runtime?${new URLSearchParams({ tenant_id: tenantId, space_id: spaceId, project_id: projectId, app_id: appId })}`));
    if (!runtime.ok) return c.json({ error_code: "extension_runtime_status_unavailable" }, 503);
    const runtimeState = await runtime.json<{ managed?: boolean; active?: boolean; releaseValid?: boolean }>().catch((): { managed?: boolean; active?: boolean; releaseValid?: boolean } => ({}));
    if (runtimeState.managed && !runtimeState.active) return c.json({ error_code: "project_extension_inactive" }, 404);
    if (runtimeState.managed && !runtimeState.releaseValid) return c.json({ error_code: "project_extension_release_invalid" }, 503);
    if (path === "/initialize" && runtimeState.managed) return c.json({ error_code: "project_extension_install_route_required" }, 409);
    const id = gadgetActorId(c.env.MICRO_APP_DO, { scope: "PROJECT_BOUND", spaceId, projectId, appId });
    const request = new Request(`http://micro-app${path}`, { method, headers: c.req.raw.headers,
      ...(method === "POST" ? { body: override ?? await c.req.arrayBuffer() } : {}) });
    return c.env.MICRO_APP_DO.get(id).fetch(request);
  };
  app.post("/spaces/:spaceId/projects/:projectId/apps/:appId/initialize", async c => {
    const blocked = await projectAccess(c, true);
    if (blocked) return blocked;
    const bytes = await c.req.arrayBuffer();
    let body: { appId?: unknown; scope?: unknown; gadgetTier?: unknown };
    try { body = JSON.parse(new TextDecoder().decode(bytes)) as typeof body; } catch { return c.json({ error_code: "bad_request" }, 400); }
    if (body.appId !== c.req.param("appId") || body.scope !== "PROJECT_BOUND" || ![2, 3].includes(Number(body.gadgetTier))) return c.json({ error_code: "gadget_install_contract_invalid" }, 400);
    return forwardProject(c, "/initialize", "POST", bytes);
  });
  app.get("/spaces/:spaceId/projects/:projectId/apps/:appId/app", c => forwardProject(c, "/app"));
  app.get("/spaces/:spaceId/projects/:projectId/apps/:appId/api/data", c => forwardProject(c, `/api/data${new URL(c.req.url).search}`));
  app.get("/spaces/:spaceId/projects/:projectId/apps/:appId/api/storage", c => forwardProject(c, "/api/storage"));
  app.post("/spaces/:spaceId/projects/:projectId/apps/:appId/api/data", c => forwardProject(c, "/api/data"));
  app.delete("/spaces/:spaceId/projects/:projectId/apps/:appId/api/data", c => forwardProject(c, `/api/data${new URL(c.req.url).search}`, "DELETE"));
  app.post("/spaces/:spaceId/projects/:projectId/apps/:appId/mcp", c => forwardProject(c, "/mcp"));
}
