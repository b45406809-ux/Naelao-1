import type { Context, Hono } from "hono";
import type { Env } from "../index.js";
import { gadgetActorId } from "../do/MicroAppDO.js";
import { readBoundedRequestBytes, requireInternalHmac } from "@naelao/http";
import { extensionRuntimeWork, releaseRuntimeWorkAfterResponse, sharedExtensionRuntimeError } from "./gadget-mcp.js";

function identity(c: Context<{ Bindings: Env }>) {
  return { tenantId: c.req.header("x-naelao-tenant-id") ?? "", role: c.req.header("x-naelao-role") ?? "viewer" };
}

function validIdentity(spaceId: string, appId: string, slug: string): boolean {
  return /^[a-zA-Z0-9_-]{1,128}$/.test(spaceId) && /^[a-z][a-z0-9_-]{1,63}$/.test(appId) && /^[a-z0-9][a-z0-9_-]{0,62}$/.test(slug);
}

function previewHostSuffix(env: Env): string | undefined {
  const suffix = env.DYNAMIC_PAGE_HOST_SUFFIX?.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  const applicationSuffix = env.APPLICATION_HOST_SUFFIX?.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  const validDomain = (value: string | undefined) => !!value && /^(?=.{1,190}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
  if (!suffix || !applicationSuffix || !validDomain(suffix) || !validDomain(applicationSuffix)) return undefined;
  // These values must be registrable-domain suffixes, never sibling hosts under one
  // cookie parent. The operator supplies the authoritative suffixes from owned zones.
  if (suffix === applicationSuffix || suffix.endsWith(`.${applicationSuffix}`) || applicationSuffix.endsWith(`.${suffix}`)) return undefined;
  return suffix;
}

async function publicTenant(c: Context<{ Bindings: Env }>, spaceId: string): Promise<string | Response> {
  const suffix = previewHostSuffix(c.env);
  if (!suffix) return c.json({ error_code: "dynamic_pages_disabled" }, 503);
  const space = await c.env.PLATFORM_DB.prepare(`SELECT s.tenant_id FROM spaces s JOIN orgs o ON o.id=s.tenant_id
    WHERE s.id = ? AND s.status = 'active' AND o.status = 'active'`).bind(spaceId).first<{ tenant_id: string }>();
  if (!space || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(space.tenant_id.toLowerCase())) return c.notFound();
  const expectedHost = `${space.tenant_id.toLowerCase()}.${suffix}`;
  if (new URL(c.req.url).hostname.toLowerCase() !== expectedHost) return c.notFound();
  return space.tenant_id;
}

async function acquirePageRuntime(env: Env, tenantId: string, spaceId: string, appId: string) {
  const runtime = await sharedExtensionRuntimeError(env, tenantId, spaceId, appId);
  if (runtime.error) return { error: runtime.error };
  if (!runtime.managed) return {};
  if (!runtime.installationId) return { error: "space_extension_runtime_unavailable" };
  const workId = crypto.randomUUID();
  const lease = await extensionRuntimeWork(env, { action: "acquire", tenantId, spaceId, projectId: null,
    installationId: runtime.installationId, workId, workKind: "gadget" });
  if (lease.acquired !== true) return { error: lease.errorCode ?? "extension_installation_inactive" };
  return { installationId: runtime.installationId, workId };
}

async function releasePageRuntime(env: Env, tenantId: string, spaceId: string, lease: { installationId?: string; workId?: string }) {
  if (!lease.installationId || !lease.workId) return;
  await extensionRuntimeWork(env, { action: "release", tenantId, spaceId, projectId: null,
    installationId: lease.installationId, workId: lease.workId, workKind: "gadget" });
}

export function registerDynamicPageRoutes(app: Hono<{ Bindings: Env }>): void {
  // Publishing trusts gateway-supplied tenant and role headers. Public preview
  // render/action routes below have their own host, origin, and token checks.
  app.use("/spaces/:spaceId/apps/:appId/pages", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
  app.post("/spaces/:spaceId/apps/:appId/pages", async c => {
    const { tenantId, role } = identity(c);
    const { spaceId, appId } = c.req.param();
    if (!tenantId) return c.json({ error_code: "unauthorized" }, 401);
    if (!validIdentity(spaceId, appId, "page")) return c.json({ error_code: "bad_request" }, 400);
    if (role !== "owner" && role !== "admin") return c.json({ error_code: "forbidden", message: "Space administrator required" }, 403);
    const owned = await c.env.PLATFORM_DB.prepare(`SELECT 1 FROM spaces s JOIN orgs o ON o.id=s.tenant_id
      WHERE s.id = ? AND s.tenant_id = ? AND s.status = 'active' AND o.status = 'active'`).bind(spaceId, tenantId).first();
    if (!owned) return c.notFound();
    const actor = gadgetActorId(c.env.MICRO_APP_DO, { scope: "SPACE_SHARED", spaceId, appId });
    let body: Uint8Array;
    try { body = await readBoundedRequestBytes(c.req.raw, 1024 * 1024); }
    catch { return c.json({ error_code: "payload_too_large" }, 413); }
    const lease = await acquirePageRuntime(c.env, tenantId, spaceId, appId);
    if (lease.error) return c.json({ error_code: lease.error }, 409);
    const release = () => releasePageRuntime(c.env, tenantId, spaceId, lease);
    try {
      const response = await c.env.MICRO_APP_DO.get(actor).fetch(new Request("http://micro-app/page/publish", {
        method: "POST", body, headers: { "content-type": "application/json" },
      }));
      return await releaseRuntimeWorkAfterResponse(new Response(response.body, { status: response.status, headers: response.headers }), release);
    } catch (error) { await release(); throw error; }
  });

  app.get("/p/:spaceId/:appId/:slug", async c => {
    const { spaceId, appId, slug } = c.req.param();
    if (!validIdentity(spaceId, appId, slug)) return c.notFound();
    const tenant = await publicTenant(c, spaceId);
    if (tenant instanceof Response) return tenant;
    const lease = await acquirePageRuntime(c.env, tenant, spaceId, appId);
    if (lease.error) return c.notFound();
    const actor = gadgetActorId(c.env.MICRO_APP_DO, { scope: "SPACE_SHARED", spaceId, appId });
    const query = new URLSearchParams({ spaceId, slug });
    const release = () => releasePageRuntime(c.env, tenant, spaceId, lease);
    try { return await releaseRuntimeWorkAfterResponse(await c.env.MICRO_APP_DO.get(actor).fetch(new Request(`http://micro-app/page/render?${query}`)), release); }
    catch (error) { await release(); throw error; }
  });

  app.post("/p/:spaceId/:appId/:slug/actions/:action", async c => {
    const { spaceId, appId, slug, action } = c.req.param();
    if (!validIdentity(spaceId, appId, slug) || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(action)) return c.notFound();
    const tenant = await publicTenant(c, spaceId);
    if (tenant instanceof Response) return tenant;
    const url = new URL(c.req.url);
    if (c.req.header("origin") !== url.origin) return c.json({ error_code: "origin_rejected" }, 403);
    let body: Uint8Array;
    try { body = await readBoundedRequestBytes(c.req.raw, 1024 * 1024); }
    catch { return c.json({ error_code: "payload_too_large" }, 413); }
    const lease = await acquirePageRuntime(c.env, tenant, spaceId, appId);
    if (lease.error) return c.notFound();
    const actor = gadgetActorId(c.env.MICRO_APP_DO, { scope: "SPACE_SHARED", spaceId, appId });
    const query = new URLSearchParams({ spaceId, slug, action });
    const release = () => releasePageRuntime(c.env, tenant, spaceId, lease);
    try {
      return await releaseRuntimeWorkAfterResponse(await c.env.MICRO_APP_DO.get(actor).fetch(new Request(`http://micro-app/page/action?${query}`, {
        method: "POST", body, headers: { "content-type": "application/json" },
      })), release);
    } catch (error) { await release(); throw error; }
  });
}
