import type { Context, Hono } from "hono";
import type { Env } from "../index.js";
import { gadgetActorId } from "../do/MicroAppDO.js";
import { getDOName } from "@naelao/crypto";
import { mintInternalToken, readBoundedRequestBytes, readBoundedRequestText, requireInternalHmac } from "@naelao/http";

const MAX_GADGET_REQUEST_BYTES = 1024 * 1024;
const MAX_CANVAS_GADGET_RESPONSE_BYTES = 512 * 1024;

export function registerGadgetMcpRoutes(app: Hono<{ Bindings: Env }>): void {
  // These routes trust gateway-stamped tenant and role headers. Verify the internal
  // signature here as well as at the router so direct Worker access cannot forge them.
  app.use("/spaces/:spaceId/apps/*", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
  app.use("/spaces/:spaceId/projects/:projectId/apps/*", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
  app.use("/spaces/:spaceId/projects/:projectId/extensions/:installationId/canvases/*", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
  const forward = async (c: Context<{ Bindings: Env }>, path: string, method = c.req.method, bodyOverride?: ArrayBuffer) => {
    const tenantId = c.req.header("x-naelao-tenant-id");
    if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
    const { spaceId, appId } = c.req.param();
    if (!spaceId || !appId || !/^[a-z][a-z0-9_-]{1,63}$/.test(appId)) return c.json({ error_code: "bad_request", message: "Invalid gadget identity" }, 400);
    const owned = await c.env.PLATFORM_DB.prepare(`SELECT 1 FROM spaces s JOIN orgs o ON o.id=s.tenant_id
      WHERE s.id = ? AND s.tenant_id = ? AND s.status = 'active' AND o.status = 'active'`).bind(spaceId, tenantId).first();
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
    let requestBody: ArrayBuffer | Uint8Array | undefined;
    if (method === "POST") {
      try { requestBody = bodyOverride ?? (await readBoundedRequestBytes(c.req.raw, MAX_GADGET_REQUEST_BYTES)).buffer as ArrayBuffer; }
      catch { return c.json({ error_code: "payload_too_large" }, 413); }
      if (requestBody.byteLength > MAX_GADGET_REQUEST_BYTES) return c.json({ error_code: "payload_too_large" }, 413);
    }
    const request = new Request(`http://micro-app${path}`, { method, headers: c.req.raw.headers, ...(requestBody ? { body: requestBody } : {}) });
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
    let bytes: Uint8Array;
    try { bytes = await readBoundedRequestBytes(c.req.raw, MAX_GADGET_REQUEST_BYTES); }
    catch { return c.json({ error_code: "payload_too_large" }, 413); }
    let body: { appId?: unknown; scope?: unknown; gadgetTier?: unknown };
    try { body = JSON.parse(new TextDecoder().decode(bytes)) as typeof body; }
    catch { return c.json({ error_code: "bad_request", message: "Invalid initialization payload" }, 400); }
    if (body.appId !== c.req.param("appId") || body.scope !== "SPACE_SHARED" || body.gadgetTier !== 3) {
      return c.json({ error_code: "bad_request", message: "Only the named SPACE_SHARED tier-3 gadget can be installed on this route" }, 400);
    }
    return forward(c, "/initialize", "POST", bytes.buffer as ArrayBuffer);
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
    const owned = await c.env.PLATFORM_DB.prepare(`SELECT 1 FROM spaces s JOIN orgs o ON o.id=s.tenant_id
      WHERE s.id=? AND s.tenant_id=? AND s.status='active' AND o.status='active'`).bind(spaceId, tenantId).first();
    if (!owned) return c.json({ error_code: "not_found" }, 404);
    const id = c.env.SPACE_DO.idFromName(await getDOName("space", spaceId, tenantId, c.env.PLATFORM_SECRET));
    const viewer = ["owner", "admin"].includes(role) ? "space_manager=1" : `viewer_id=${encodeURIComponent(userId)}`;
    const project = await c.env.SPACE_DO.get(id).fetch(new Request(`http://space-do/projects/${encodeURIComponent(projectId)}?${viewer}`));
    if (!project.ok) return c.json({ error_code: project.status === 404 ? "not_found" : "forbidden" }, project.status === 404 ? 404 : 403);
    return null;
  };
  const forwardProject = async (c: Context<{ Bindings: Env }>, path: string, method = c.req.method, override?: ArrayBuffer, memberWrite = false) => {
    const blocked = await projectAccess(c, method !== "GET" && !memberWrite);
    if (blocked) return blocked;
    const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
    const { spaceId = "", projectId = "", appId = "" } = c.req.param();
    if (!appId || !/^[a-z][a-z0-9_-]{1,63}$/.test(appId)) return c.json({ error_code: "bad_request" }, 400);
    const spaceDoId = c.env.SPACE_DO.idFromName(await getDOName("space", spaceId, tenantId, c.env.PLATFORM_SECRET));
    const runtime = await c.env.SPACE_DO.get(spaceDoId).fetch(new Request(`http://space-do/project-extension-runtime?${new URLSearchParams({ tenant_id: tenantId, space_id: spaceId, project_id: projectId, app_id: appId })}`));
    if (!runtime.ok) return c.json({ error_code: "extension_runtime_status_unavailable" }, 503);
    const runtimeState = await runtime.json<{ managed?: boolean; active?: boolean; releaseValid?: boolean; publisherKeyId?: string }>().catch((): { managed?: boolean; active?: boolean; releaseValid?: boolean; publisherKeyId?: string } => ({}));
    if (runtimeState.managed && !runtimeState.active) return c.json({ error_code: "project_extension_inactive" }, 404);
    if (runtimeState.managed && !runtimeState.releaseValid) return c.json({ error_code: "project_extension_release_invalid" }, 503);
    if (runtimeState.managed && runtimeState.publisherKeyId) {
      const trustedPublisher = await c.env.PLATFORM_DB.prepare(`SELECT 1 AS active FROM extension_publisher_keys
        WHERE tenant_id=? AND space_id=? AND key_id=? AND status='active'`).bind(tenantId, spaceId, runtimeState.publisherKeyId).first();
      if (!trustedPublisher) return c.json({ error_code: "project_extension_publisher_revoked" }, 503);
    }
    if (path === "/initialize" && runtimeState.managed) return c.json({ error_code: "project_extension_install_route_required" }, 409);
    const id = gadgetActorId(c.env.MICRO_APP_DO, { scope: "PROJECT_BOUND", spaceId, projectId, appId });
    let requestBody: ArrayBuffer | Uint8Array | undefined;
    if (method === "POST") {
      try { requestBody = override ?? (await readBoundedRequestBytes(c.req.raw, MAX_GADGET_REQUEST_BYTES)).buffer as ArrayBuffer; }
      catch { return c.json({ error_code: "payload_too_large" }, 413); }
      if (requestBody.byteLength > MAX_GADGET_REQUEST_BYTES) return c.json({ error_code: "payload_too_large" }, 413);
    }
    const request = new Request(`http://micro-app${path}`, { method, headers: c.req.raw.headers, ...(requestBody ? { body: requestBody } : {}) });
    return c.env.MICRO_APP_DO.get(id).fetch(request);
  };
  app.post("/spaces/:spaceId/projects/:projectId/apps/:appId/initialize", async c => {
    const blocked = await projectAccess(c, true);
    if (blocked) return blocked;
    let bytes: Uint8Array;
    try { bytes = await readBoundedRequestBytes(c.req.raw, MAX_GADGET_REQUEST_BYTES); }
    catch { return c.json({ error_code: "payload_too_large" }, 413); }
    let body: { appId?: unknown; scope?: unknown; gadgetTier?: unknown };
    try { body = JSON.parse(new TextDecoder().decode(bytes)) as typeof body; } catch { return c.json({ error_code: "bad_request" }, 400); }
    if (body.appId !== c.req.param("appId") || body.scope !== "PROJECT_BOUND" || ![2, 3].includes(Number(body.gadgetTier))) return c.json({ error_code: "gadget_install_contract_invalid" }, 400);
    return forwardProject(c, "/initialize", "POST", bytes.buffer as ArrayBuffer);
  });
  app.get("/spaces/:spaceId/projects/:projectId/apps/:appId/app", c => forwardProject(c, "/app"));
  app.get("/spaces/:spaceId/projects/:projectId/apps/:appId/api/data", c => forwardProject(c, `/api/data${new URL(c.req.url).search}`));
  app.get("/spaces/:spaceId/projects/:projectId/apps/:appId/api/storage", c => forwardProject(c, "/api/storage"));
  app.post("/spaces/:spaceId/projects/:projectId/apps/:appId/api/data", c => forwardProject(c, "/api/data"));
  app.delete("/spaces/:spaceId/projects/:projectId/apps/:appId/api/data", c => forwardProject(c, `/api/data${new URL(c.req.url).search}`, "DELETE"));
  app.post("/spaces/:spaceId/projects/:projectId/apps/:appId/mcp", c => forwardProject(c, "/mcp"));
  app.get("/spaces/:spaceId/projects/:projectId/apps/:appId/collaboration", c => forwardProject(c, `/api/collaboration${new URL(c.req.url).search}`, "GET"));
  app.get("/spaces/:spaceId/projects/:projectId/apps/:appId/action-audit", c => {
    if (!["owner", "admin"].includes(c.req.header("x-naelao-role") ?? "")) return c.json({ error_code: "forbidden", message: "Gadget action audit requires project administration" }, 403);
    return forwardProject(c, `/api/actions/audit${new URL(c.req.url).search}`, "GET");
  });
  app.post("/spaces/:spaceId/projects/:projectId/apps/:appId/collaboration", async c => {
    let body: { kind?: unknown; payload?: unknown };
    try { body = JSON.parse(await readBoundedRequestText(c.req.raw, 4_500)) as typeof body; } catch { return c.json({ error_code: "canvas_collaboration_event_invalid" }, 400); }
    if (!["cursor", "comment", "operation"].includes(String(body.kind))) return c.json({ error_code: "canvas_collaboration_event_invalid" }, 400);
    // All current project members may publish cursors, comments, and operation traces. This
    // endpoint never mutates Gadget tables or invokes a tool; those retain owner/admin policy.
    const bytes = new TextEncoder().encode(JSON.stringify(body)).byteLength;
    if (bytes > 4_500) return c.json({ error_code: "canvas_collaboration_payload_too_large" }, 413);
    return forwardProject(c, "/api/collaboration", "POST", new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer, true);
  });

  // Project canvases receive read-only access to only the Gadget tables explicitly named in
  // their signed extension release. Writes remain planner/worker operations with normal grants.
  app.get("/spaces/:spaceId/projects/:projectId/extensions/:installationId/canvases/:canvasId/gadgets/:gadgetId/records", async c => {
    const blocked = await projectAccess(c, false);
    if (blocked) return blocked;
    const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
    const { spaceId = "", projectId = "" } = c.req.param();
    const { installationId = "", canvasId = "", gadgetId = "" } = c.req.param();
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(installationId) || !/^[a-z][a-z0-9._-]{1,63}$/.test(canvasId)
      || !/^[a-z][a-z0-9._-]{1,63}$/.test(gadgetId)) return c.json({ error_code: "canvas_gadget_read_invalid" }, 400);
    const operation = c.req.query("operation"), table = c.req.query("table"), rowId = c.req.query("id");
    if (!(operation === "list" || operation === "get") || !table || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(table)
      || operation === "get" && (!rowId || rowId.length > 256)
      || operation === "list" && rowId !== undefined) return c.json({ error_code: "canvas_gadget_read_invalid" }, 400);
    const spaceDoId = c.env.SPACE_DO.idFromName(await getDOName("space", spaceId, tenantId, c.env.PLATFORM_SECRET));
    const spaceDo = c.env.SPACE_DO.get(spaceDoId);
    const installationUrl = new URL("http://space-do/workflow-installation");
    installationUrl.search = new URLSearchParams({ instance_id: installationId, tenant_id: tenantId, space_id: spaceId }).toString();
    const installedResponse = await spaceDo.fetch(new Request(installationUrl, { headers: { "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, tenantId) } }));
    if (!installedResponse.ok) return c.json({ error_code: "extension_installation_unavailable" }, installedResponse.status === 404 ? 404 : 503);
    const installed = await installedResponse.json<{
      instance?: { instance_id?: string; tenant_id?: string; space_id?: string; project_id?: string | null; instance_key?: string | null; scope?: string; status?: string };
      manifest?: { id?: string; bundle?: { id?: string; primitives?: Array<{ id?: string; kind?: string; gadgetReads?: Array<{ gadgetId: string; tables: string[] }> }> } };
      release?: { signatureValid?: boolean; publisher?: { keyId?: string; revoked?: boolean } } | null;
    }>();
    const instance = installed.instance, bundle = installed.manifest?.bundle;
    const canvas = bundle?.primitives?.find(part => part.id === canvasId && part.kind === "canvas");
    const declaredRead = canvas?.gadgetReads?.find(grant => grant.gadgetId === gadgetId && grant.tables.includes(table));
    const gadgetExists = bundle?.primitives?.some(part => part.id === gadgetId && part.kind === "gadget");
    if (!instance || instance.instance_id !== installationId || instance.tenant_id !== tenantId || instance.space_id !== spaceId
      || instance.project_id !== projectId || instance.scope !== "PROJECT_BOUND" || instance.status !== "active"
      || !installed.manifest?.id || installed.manifest.id !== bundle?.id || !canvas || !gadgetExists || !declaredRead
      || installed.release?.signatureValid !== true || installed.release.publisher?.revoked) return c.json({ error_code: "canvas_gadget_read_not_granted" }, 403);
    const appId = instance.instance_key && instance.instance_key !== "default" ? `${instance.instance_key}_${gadgetId}` : gadgetId;
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(appId)) return c.json({ error_code: "extension_gadget_identity_invalid" }, 400);
    const runtimeUrl = new URL("http://space-do/project-extension-runtime");
    runtimeUrl.search = new URLSearchParams({ tenant_id: tenantId, space_id: spaceId, project_id: projectId, app_id: appId }).toString();
    const runtimeResponse = await spaceDo.fetch(new Request(runtimeUrl));
    if (!runtimeResponse.ok) return c.json({ error_code: "extension_runtime_status_unavailable" }, 503);
    const runtime = await runtimeResponse.json<{ active?: boolean; releaseValid?: boolean; publisherKeyId?: string }>();
    if (!runtime.active || !runtime.releaseValid) return c.json({ error_code: "project_extension_release_invalid" }, 503);
    if (runtime.publisherKeyId) {
      const trustedPublisher = await c.env.PLATFORM_DB.prepare(`SELECT 1 AS active FROM extension_publisher_keys
        WHERE tenant_id=? AND space_id=? AND key_id=? AND status='active'`).bind(tenantId, spaceId, runtime.publisherKeyId).first();
      if (!trustedPublisher) return c.json({ error_code: "project_extension_publisher_revoked" }, 503);
    }
    const args: Record<string, unknown> = { table };
    if (operation === "get") args.id = rowId;
    else {
      const limit = Number(c.req.query("limit") ?? "100");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) return c.json({ error_code: "canvas_gadget_read_limit_invalid" }, 400);
      args.limit = limit;
    }
    const actor = gadgetActorId(c.env.MICRO_APP_DO, { scope: "PROJECT_BOUND", spaceId, projectId, appId });
    const response = await c.env.MICRO_APP_DO.get(actor).fetch(new Request("http://micro-app/mcp", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-user-id": c.req.header("x-naelao-user-id") ?? "canvas" },
      body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name: `app_${appId}_${operation}`, arguments: args } }),
    }));
    if (!response.body) return response;
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_CANVAS_GADGET_RESPONSE_BYTES) {
        await reader.cancel();
        return c.json({ error_code: "canvas_gadget_response_too_large", maximum_bytes: MAX_CANVAS_GADGET_RESPONSE_BYTES }, 413);
      }
      chunks.push(chunk.value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  });
}
