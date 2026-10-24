import type { Hono } from "hono";
import type { Env } from "../index.js";
import { getDOName } from "@naelao/crypto";
import { verifyInternalToken, readBoundedRequestText } from "@naelao/http";
import { resolveEndUserBusinessRole } from "../business-auth.js";
export function registerAssistantChannelRoutes(app: Hono<{ Bindings: Env }>) {
  app.get("/internal/spaces/:spaceId/assistant-channels", async (c) => {
    const tenant = c.req.header("x-naelao-tenant-id") ?? "",
      space = c.req.param("spaceId");
    if (
      !tenant ||
      !(await verifyInternalToken(
        c.req.header("x-naelao-internal-token"),
        tenant,
        c.env.PLATFORM_SECRET
      ))
    )
      return c.json({ error_code: "forbidden" }, 403);
    if (
      !(await c.env.PLATFORM_DB.prepare(
        "SELECT id FROM spaces WHERE id=? AND tenant_id=? AND status!='deleted'"
      )
        .bind(space, tenant)
        .first())
    )
      return c.json({ error_code: "not_found" }, 404);
    const query = new URLSearchParams({
      user_id: c.req.query("actor_id") ?? "__background",
      ...(c.req.query("project_id")
        ? { project_id: c.req.query("project_id")! }
        : {}),
    });
    const stub = c.env.SPACE_DO.get(
      c.env.SPACE_DO.idFromName(
        await getDOName("space", space, tenant, c.env.PLATFORM_SECRET)
      )
    );
    const response = await stub.fetch(
      new Request("http://space/assistant-channels?" + query)
    );
    return new Response(response.body, {
      status: response.status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  });
  app.on(["GET", "PATCH"], "/spaces/:spaceId/assistant-channels", async (c) => {
    const tenant = c.req.header("x-naelao-tenant-id") ?? "",
      user = c.req.header("x-naelao-user-id") ?? "",
      space = c.req.param("spaceId");
    if (
      !tenant ||
      !user ||
      !(await verifyInternalToken(
        c.req.header("x-naelao-internal-token"),
        tenant,
        c.env.PLATFORM_SECRET
      ))
    )
      return c.json({ error_code: "forbidden" }, 403);
    if (
      !(await c.env.PLATFORM_DB.prepare(
        "SELECT id FROM spaces WHERE id=? AND tenant_id=? AND status!='deleted'"
      )
        .bind(space, tenant)
        .first())
    )
      return c.json({ error_code: "not_found" }, 404);
    const role =
      c.req.header("x-naelao-role") === "product_end_user"
        ? await resolveEndUserBusinessRole(c.env.PLATFORM_DB, space, user)
        : c.req.header("x-naelao-role");
    if (!role) return c.json({ error_code: "forbidden" }, 403);
    const stub = c.env.SPACE_DO.get(
      c.env.SPACE_DO.idFromName(
        await getDOName("space", space, tenant, c.env.PLATFORM_SECRET)
      )
    );
    const project = c.req.query("project_id"),
      defaults = c.req.query("project_defaults") === "true";
    const query = new URLSearchParams({
      space_id: space,
      user_id: user,
      ...(project ? { project_id: project } : {}),
      ...(defaults ? { project_defaults: "true" } : {}),
    });
    let projectRole: string | undefined;
    if (project) {
      const r = await stub.fetch(
        new Request(
          `http://space/projects/${encodeURIComponent(project)}/assistant-access?user_id=${encodeURIComponent(user)}`
        )
      );
      projectRole = r.ok
        ? (await r.json<{ effective_role?: string }>()).effective_role
        : undefined;
      if (!projectRole) return c.json({ error_code: "forbidden" }, 403);
    }
    let body: Record<string, unknown> | undefined;
    if (c.req.method === "PATCH") {
      try {
        body = JSON.parse(await readBoundedRequestText(c.req.raw, 16384));
      } catch {
        return c.json({ error_code: "bad_request" }, 400);
      }
      const admin = ["owner", "admin"].includes(role);
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        (defaults && !admin) ||
        (body.templateDefaults !== undefined && !admin) ||
        (project && !admin && projectRole !== "owner") ||
        role === "viewer"
      )
        return c.json({ error_code: "forbidden" }, 403);
    }
    const response = await stub.fetch(
      new Request("http://space/assistant-channels?" + query, {
        method: c.req.method,
        ...(body
          ? {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }
          : {}),
      })
    );
    return new Response(response.body, {
      status: response.status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  });
}
