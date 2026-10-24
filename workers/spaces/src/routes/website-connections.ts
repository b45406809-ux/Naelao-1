import type { Hono, Context } from "hono";
import type { Env } from "../index.js";
import { getDOName } from "@naelao/crypto";
import {
  mintInternalToken,
  verifyInternalToken,
  readBoundedRequestText,
} from "@naelao/http";
import { checkSsrf } from "@naelao/security";
import type { BrowserRuntimeScope } from "@naelao/agent-sdk";
import { resolveEndUserBusinessRole } from "../business-auth.js";
type C = Context<{ Bindings: Env }>;
interface Connection {
  id: string;
  tenant_id: string;
  space_id: string;
  owner_user_id: string;
  project_id: string | null;
  name: string;
  start_url: string;
  origins_json: string;
  agent_ids_json: string;
  status: string;
}
async function workspaceAccess(
  c: C,
  tenant: string,
  space: string,
  user: string,
  project?: string | null
): Promise<boolean> {
  if (!tenant || !space || !user) return false;
  if (
    !(await c.env.PLATFORM_DB.prepare(
      "SELECT id FROM spaces WHERE id=? AND tenant_id=? AND status='active'"
    )
      .bind(space, tenant)
      .first())
  )
    return false;
  const stub = c.env.SPACE_DO.get(
    c.env.SPACE_DO.idFromName(
      await getDOName("space", space, tenant, c.env.PLATFORM_SECRET)
    )
  );
  const role = await resolveEndUserBusinessRole(c.env.PLATFORM_DB, space, user);
  if (!role) {
    const response = await stub.fetch(
      new Request("http://space/members?space_id=" + encodeURIComponent(space))
    );
    const roster = response.ok
      ? await response.json<{
          data?: Array<{ user_id: string; role: string }>;
        }>()
      : {};
    if (
      !roster.data?.some(
        (item) =>
          item.user_id === user &&
          ["owner", "admin", "member", "editor", "operator"].includes(item.role)
      )
    )
      return false;
  } else if (role === "viewer") return false;
  if (project) {
    const response = await stub.fetch(
      new Request(
        "http://space/projects/" +
          encodeURIComponent(project) +
          "/assistant-access?user_id=" +
          encodeURIComponent(user)
      )
    );
    const access = response.ok
      ? await response.json<{ effective_role?: string }>()
      : {};
    if (!["owner", "editor"].includes(access.effective_role ?? ""))
      return false;
  }
  return true;
}
async function identity(c: C) {
  const tenant = c.req.header("x-naelao-tenant-id") ?? "",
    user = c.req.header("x-naelao-user-id") ?? "";
  if (
    !tenant ||
    !user ||
    !(await verifyInternalToken(
      c.req.header("x-naelao-internal-token"),
      tenant,
      c.env.PLATFORM_SECRET
    ))
  )
    return null;
  return (await workspaceAccess(c, tenant, c.req.param("spaceId")!, user))
    ? { tenant, user }
    : null;
}
async function browser(c: C, tenant: string, path: string, body: unknown) {
  if (!c.env.BROWSER_WORKER)
    return new Response(JSON.stringify({ error_code: "browser_unavailable" }), {
      status: 503,
    });
  const res = await c.env.BROWSER_WORKER.fetch(
    new Request("http://browser/v1/" + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": tenant,
        "x-naelao-internal-token": await mintInternalToken(
          c.env.PLATFORM_SECRET,
          tenant
        ),
      },
      body: JSON.stringify(body),
    })
  );
  return new Response(res.body, {
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    },
  });
}
export function registerWebsiteConnectionRoutes(app: Hono<{ Bindings: Env }>) {
  app.post("/internal/website-connection-authorize", async (c) => {
    const tenant = c.req.header("x-naelao-tenant-id") ?? "";
    if (
      !tenant ||
      !(await verifyInternalToken(
        c.req.header("x-naelao-internal-token"),
        tenant,
        c.env.PLATFORM_SECRET
      ))
    )
      return c.json({ error_code: "forbidden" }, 403);
    const scope = JSON.parse(
      await readBoundedRequestText(c.req.raw, 16384)
    ) as BrowserRuntimeScope;
    const row = await c.env.PLATFORM_DB.prepare(
      "SELECT * FROM website_connections WHERE id=? AND tenant_id=? AND status='active'"
    )
      .bind(scope.connectionId ?? "", tenant)
      .first<Connection>();
    if (
      !row ||
      row.space_id !== scope.spaceId ||
      row.owner_user_id !== scope.actorId ||
      (row.project_id ?? undefined) !== scope.projectId ||
      scope.tenantId !== tenant
    )
      return c.json({ error_code: "forbidden" }, 403);
    const agents = JSON.parse(row.agent_ids_json) as string[];
    if (
      !(
        scope.agentId === "website-login" &&
        c.req.header("x-naelao-browser-human-login") === "true"
      ) &&
      agents.length &&
      !agents.includes(scope.agentId)
    )
      return c.json({ error_code: "forbidden" }, 403);
    const origins = JSON.parse(row.origins_json) as string[];
    if (
      !scope.authorizedOrigins.every((origin) => origins.includes(origin)) ||
      !(await workspaceAccess(
        c,
        tenant,
        row.space_id,
        row.owner_user_id,
        row.project_id
      ))
    )
      return c.json({ error_code: "forbidden" }, 403);
    return c.json({ ok: true });
  });
  app.get("/spaces/:spaceId/website-connections", async (c) => {
    const caller = await identity(c);
    if (!caller) return c.json({ error_code: "forbidden" }, 403);
    const { results } = await c.env.PLATFORM_DB.prepare(
      "SELECT id,name,project_id,start_url,origins_json,agent_ids_json FROM website_connections WHERE tenant_id=? AND space_id=? AND owner_user_id=? AND status='active' ORDER BY created_at DESC LIMIT 100"
    )
      .bind(caller.tenant, c.req.param("spaceId"), caller.user)
      .all<Connection>();
    return c.json({
      data: results.map((row) => ({
        id: row.id,
        name: row.name,
        project_id: row.project_id,
        start_url: row.start_url,
        origins: JSON.parse(row.origins_json),
        agent_ids: JSON.parse(row.agent_ids_json),
      })),
    });
  });
  app.post("/spaces/:spaceId/website-connections", async (c) => {
    const caller = await identity(c);
    if (!caller) return c.json({ error_code: "forbidden" }, 403);
    const body = JSON.parse(await readBoundedRequestText(c.req.raw, 16384)) as {
      name?: string;
      start_url?: string;
      project_id?: string;
      origins?: string[];
      agent_ids?: string[];
    };
    if (
      typeof body.name !== "string" ||
      !body.name.trim() ||
      body.name.length > 100 ||
      typeof body.start_url !== "string" ||
      body.start_url.length > 2048
    )
      return c.json({ error_code: "invalid_website" }, 400);
    let url: URL;
    try {
      url = new URL(body.start_url);
    } catch {
      return c.json({ error_code: "invalid_url" }, 400);
    }
    const origins = Array.from(
      new Set([
        url.origin,
        ...(Array.isArray(body.origins) ? body.origins : []),
      ])
    );
    if (origins.length > 16) return c.json({ error_code: "origin_limit" }, 400);
    for (const origin of origins) {
      try {
        const parsed = new URL(origin);
        if (
          parsed.protocol !== "https:" ||
          parsed.origin !== origin ||
          parsed.username ||
          parsed.password ||
          (await checkSsrf(origin)).blocked
        )
          throw Error();
      } catch {
        return c.json({ error_code: "invalid_origin" }, 400);
      }
    }
    if (url.username || url.password || url.protocol !== "https:")
      return c.json({ error_code: "invalid_url" }, 400);
    if (
      body.project_id !== undefined &&
      (typeof body.project_id !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(body.project_id))
    )
      return c.json({ error_code: "invalid_project" }, 400);
    if (
      body.project_id &&
      !(await workspaceAccess(
        c,
        caller.tenant,
        c.req.param("spaceId"),
        caller.user,
        body.project_id
      ))
    )
      return c.json({ error_code: "project_access_required" }, 403);
    const agents = body.agent_ids ?? [];
    if (
      !Array.isArray(agents) ||
      agents.length > 32 ||
      agents.some(
        (id) =>
          typeof id !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(id)
      )
    )
      return c.json({ error_code: "invalid_agents" }, 400);
    const id = crypto.randomUUID();
    const inserted = await c.env.PLATFORM_DB.prepare(
      "INSERT INTO website_connections(id,tenant_id,space_id,owner_user_id,project_id,name,start_url,origins_json,agent_ids_json) SELECT ?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM website_connections WHERE tenant_id=? AND space_id=? AND owner_user_id=? AND status='active')<100"
    )
      .bind(
        id,
        caller.tenant,
        c.req.param("spaceId"),
        caller.user,
        body.project_id ?? null,
        body.name.trim(),
        url.href,
        JSON.stringify(origins),
        JSON.stringify(agents),
        caller.tenant,
        c.req.param("spaceId"),
        caller.user
      )
      .run();
    if (!inserted.meta.changes)
      return c.json({ error_code: "website_connection_limit" }, 429);
    return c.json({ id }, 201);
  });
  app.delete("/spaces/:spaceId/website-connections", async (c) => {
    const caller = await identity(c);
    if (!caller) return c.json({ error_code: "forbidden" }, 403);
    const row = await c.env.PLATFORM_DB.prepare(
      "SELECT * FROM website_connections WHERE id=? AND tenant_id=? AND space_id=? AND owner_user_id=?"
    )
      .bind(
        c.req.query("id") ?? "",
        caller.tenant,
        c.req.param("spaceId"),
        caller.user
      )
      .first<Connection>();
    if (!row) return c.json({ error_code: "not_found" }, 404);
    await c.env.PLATFORM_DB.prepare(
      "UPDATE website_connections SET status='revoked' WHERE id=?"
    )
      .bind(row.id)
      .run();
    return browser(c, caller.tenant, "website-profile/revoke", {
      tenantId: caller.tenant,
      spaceId: row.space_id,
      actorId: caller.user,
      agentId: "website-login",
      runId: row.id,
      sessionId: row.id,
      connectionId: row.id,
      ...(row.project_id ? { projectId: row.project_id } : {}),
      expiresAt: Date.now() + 60000,
      maxTier: 5,
      authorizedOrigins: JSON.parse(row.origins_json),
      authorizedActions: [],
    });
  });
  app.post("/spaces/:spaceId/website-browser", async (c) => {
    const caller = await identity(c);
    if (!caller) return c.json({ error_code: "forbidden" }, 403);
    const body = JSON.parse(await readBoundedRequestText(c.req.raw, 16384)) as {
      id: string;
      session_id: string;
      operation: string;
      action?: unknown;
    };
    if (
      !/^[a-zA-Z0-9-]{1,80}$/.test(body.session_id) ||
      !["navigate", "observe", "act", "see", "close"].includes(body.operation)
    )
      return c.json({ error_code: "bad_request" }, 400);
    const row = await c.env.PLATFORM_DB.prepare(
      "SELECT * FROM website_connections WHERE id=? AND tenant_id=? AND space_id=? AND owner_user_id=? AND status='active'"
    )
      .bind(body.id, caller.tenant, c.req.param("spaceId"), caller.user)
      .first<Connection>();
    if (
      !row ||
      !(await workspaceAccess(
        c,
        caller.tenant,
        row.space_id,
        caller.user,
        row.project_id
      ))
    )
      return c.json({ error_code: "forbidden" }, 403);
    const scope: BrowserRuntimeScope = {
      tenantId: caller.tenant,
      spaceId: row.space_id,
      actorId: caller.user,
      agentId: "website-login",
      runId: body.session_id,
      sessionId: body.session_id,
      connectionId: row.id,
      ...(row.project_id ? { projectId: row.project_id } : {}),
      expiresAt: Date.now() + 600000,
      maxTier: 5,
      authorizedOrigins: JSON.parse(row.origins_json),
      authorizedActions: ["click", "type", "select", "scroll"],
    };
    const result = await browser(
      c,
      caller.tenant,
      "browser/" + body.operation,
      {
        scope,
        ...(body.operation === "navigate" ? { url: row.start_url } : {}),
        action: body.action,
        interactive: true,
        humanLogin: true,
        visual: body.operation !== "see" && body.operation !== "close",
      }
    );
    if (body.operation !== "see" || !result.ok) return result;
    const bytes = new Uint8Array(await result.arrayBuffer());
    if (bytes.length > 4 * 1024 * 1024)
      return c.json({ error_code: "browser_screenshot_limit" }, 413);
    return c.json(
      {
        image_base64: btoa(
          Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")
        ),
      },
      200,
      { "cache-control": "no-store" }
    );
  });
}
