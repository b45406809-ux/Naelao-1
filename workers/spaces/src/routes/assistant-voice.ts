import type { Hono } from "hono";
import type { Env } from "../index.js";
import { getDOName } from "@naelao/crypto";
import { verifyInternalToken, readBoundedRequestText } from "@naelao/http";
import { resolveEndUserBusinessRole } from "../business-auth.js";

export function registerAssistantVoiceRoutes(app: Hono<{ Bindings: Env }>) {
  app.on(["GET", "PATCH"], "/spaces/:spaceId/assistant-voice", async c => {
    const tenant = c.req.header("x-naelao-tenant-id") ?? "", user = c.req.header("x-naelao-user-id") ?? "";
    const space = c.req.param("spaceId"), project = c.req.query("project_id");
    if (!tenant || !user || !await verifyInternalToken(c.req.header("x-naelao-internal-token"), tenant, c.env.PLATFORM_SECRET)) return c.json({ error_code: "forbidden" }, 403);
    if (!await c.env.PLATFORM_DB.prepare("SELECT id FROM spaces WHERE id=? AND tenant_id=? AND status='active'").bind(space, tenant).first()) return c.json({ error_code: "not_found" }, 404);
    const role = c.req.header("x-naelao-role") === "product_end_user" ? await resolveEndUserBusinessRole(c.env.PLATFORM_DB, space, user) : c.req.header("x-naelao-role");
    if (!role || !["owner", "admin", "member", "editor", "operator", "viewer", "moderator"].includes(role)) return c.json({ error_code: "forbidden" }, 403);
    const stub = c.env.SPACE_DO.get(c.env.SPACE_DO.idFromName(await getDOName("space", space, tenant, c.env.PLATFORM_SECRET)));
    let projectRole: string | undefined;
    if (project) {
      const access = await stub.fetch(new Request(`http://space/projects/${encodeURIComponent(project)}/assistant-access?user_id=${encodeURIComponent(user)}`));
      projectRole = access.ok ? (await access.json<{ effective_role?: string }>()).effective_role : undefined;
      if (!projectRole) return c.json({ error_code: "forbidden" }, 403);
    }
    const admin = role === "owner" || role === "admin";
    if (c.req.method === "PATCH" && !(admin || project && projectRole === "owner")) return c.json({ error_code: "forbidden" }, 403);
    let body: string | undefined;
    if (c.req.method === "PATCH") {
      try { body = await readBoundedRequestText(c.req.raw, 8192); JSON.parse(body); }
      catch { return c.json({ error_code: "invalid_voice_preferences" }, 400); }
    }
    const query = new URLSearchParams({ space_id: space, ...(project ? { project_id: project } : {}) });
    const response = await stub.fetch(new Request(`http://space/assistant-voice?${query}`, { method: c.req.method, ...(body !== undefined ? { body, headers: { "content-type": "application/json" } } : {}) }));
    return new Response(response.body, { status: response.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  });
}
