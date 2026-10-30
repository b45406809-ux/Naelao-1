// Portal Router — subdomain + custom-domain routing for Space end-user portals
import { Hono, type Context } from "hono";
import { errorResponse, requestId, readBoundedRequestText, RequestBodyTooLargeError, requireInternalHmac } from "@naelao/http";

interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  PORTAL_ORIGIN: string;
  PLATFORM_DB: D1Database;
}

interface DomainMapping {
  spaceId: string;
  tenantId: string;
}

async function isActiveTenantSpace(db: D1Database, tenantId: string, spaceId: string): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 FROM spaces s JOIN orgs o ON o.id = s.tenant_id AND o.status = 'active'
      WHERE s.id = ? AND s.tenant_id = ? AND s.status = 'active'`
  ).bind(spaceId, tenantId).first();
  return row !== null;
}

async function reserveDomain(db: D1Database, kind: "domain" | "subdomain", hostname: string, tenantId: string, spaceId: string): Promise<boolean> {
  await db.prepare("INSERT INTO portal_domains (kind, hostname, tenant_id, space_id) VALUES (?, ?, ?, ?) ON CONFLICT(kind, hostname) DO NOTHING")
    .bind(kind, hostname, tenantId, spaceId).run();
  const existing = await db.prepare("SELECT tenant_id, space_id FROM portal_domains WHERE kind = ? AND hostname = ?")
    .bind(kind, hostname).first<{ tenant_id: string; space_id: string }>();
  return existing?.tenant_id === tenantId && existing.space_id === spaceId;
}

async function isVerifiedCustomDomain(db: D1Database, tenantId: string, spaceId: string, domain: string): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 FROM space_domains d
      JOIN spaces s ON s.id = d.space_id AND s.tenant_id = d.tenant_id AND s.status = 'active'
      JOIN orgs o ON o.id = d.tenant_id AND o.status = 'active'
      WHERE d.tenant_id = ? AND d.space_id = ? AND d.domain = ? AND d.status = 'active'`
  ).bind(tenantId, spaceId, domain).first();
  return row !== null;
}

function validateEnv(env: Env): void {
  if (!env.PLATFORM_SECRET) throw new Error("Missing required secret: PLATFORM_SECRET");
}

const app = new Hono<{ Bindings: Env }>();
app.use("*", requestId);
app.use("*", async (c, next) => {
  validateEnv(c.env);
  await next();
});

// These management routes are internal APIs, not end-user ingress. The worker's identity
// headers are otherwise caller-controlled when it is reached through a custom host.
for (const path of ["/v1/domains", "/v1/domains/*", "/v1/subdomains", "/v1/subdomains/*"]) {
  app.use(path, requireInternalHmac((c) => String(c.env.PLATFORM_SECRET ?? "")));
}

// POST /v1/domains — register a custom domain for a Space
app.post("/v1/domains", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);

  let body: { domain?: unknown; space_id?: unknown };
  try { body = JSON.parse(await readBoundedRequestText(c.req.raw, 16 * 1024)) as typeof body; }
  catch (err) {
    if (err instanceof RequestBodyTooLargeError) return c.json({ error_code: "payload_too_large" }, 413);
    return c.json({ error_code: "bad_request", message: "Expected JSON request body" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)
      || typeof body.domain !== "string" || typeof body.space_id !== "string" || !body.space_id || body.space_id.length > 128) {
    return c.json({ error_code: "bad_request", message: "domain and space_id required" }, 400);
  }

  // Basic domain format validation (lowercase alphanumeric, hyphens, dots)
  if (!/^[a-z0-9.-]{1,253}$/.test(body.domain)
      || body.domain.split(".").length < 2
      || body.domain.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    return c.json({ error_code: "bad_request", message: "Invalid domain format" }, 400);
  }

  if (!await isActiveTenantSpace(c.env.PLATFORM_DB, tenantId, body.space_id)) return c.json({ error_code: "not_found", message: "Active Space not found" }, 404);
  // A mapping alone must never claim an arbitrary hostname. The Spaces worker marks a
  // custom hostname active only after Cloudflare for SaaS has completed ownership checks.
  if (!await isVerifiedCustomDomain(c.env.PLATFORM_DB, tenantId, body.space_id, body.domain)) {
    return c.json({ error_code: "conflict", message: "Custom domain must be verified and active first" }, 409);
  }

  if (!await reserveDomain(c.env.PLATFORM_DB, "domain", body.domain, tenantId, body.space_id)) {
    return c.json({ error_code: "conflict", message: "Domain is already registered" }, 409);
  }

  return c.json({ domain: body.domain, space_id: body.space_id, status: "active" }, 201);
});

// POST /v1/subdomains — register a naelao.app subdomain for a Space
app.post("/v1/subdomains", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);

  let body: { subdomain?: unknown; space_id?: unknown };
  try { body = JSON.parse(await readBoundedRequestText(c.req.raw, 16 * 1024)) as typeof body; }
  catch (err) {
    if (err instanceof RequestBodyTooLargeError) return c.json({ error_code: "payload_too_large" }, 413);
    return c.json({ error_code: "bad_request", message: "Expected JSON request body" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)
      || typeof body.subdomain !== "string" || typeof body.space_id !== "string" || !body.space_id || body.space_id.length > 128) {
    return c.json({ error_code: "bad_request", message: "subdomain and space_id required" }, 400);
  }

  // Subdomain: only lowercase alphanumeric + hyphens, 3-63 chars
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(body.subdomain)) {
    return c.json({ error_code: "bad_request", message: "Invalid subdomain format" }, 400);
  }

  const reserved = new Set(["www", "api", "admin", "app", "portal", "mcp", "status"]);
  if (reserved.has(body.subdomain)) return c.json({ error_code: "bad_request", message: "Subdomain is reserved" }, 400);
  if (!await isActiveTenantSpace(c.env.PLATFORM_DB, tenantId, body.space_id)) return c.json({ error_code: "not_found", message: "Active Space not found" }, 404);

  if (!await reserveDomain(c.env.PLATFORM_DB, "subdomain", body.subdomain, tenantId, body.space_id)) {
    return c.json({ error_code: "conflict", message: "Subdomain is already registered" }, 409);
  }

  return c.json(
    {
      subdomain: body.subdomain,
      url: `https://${body.subdomain}.naelao.app`,
      space_id: body.space_id,
      status: "active",
    },
    201
  );
});

// GET /v1/domains — list domain mappings for tenant
app.get("/v1/domains", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const cursor = new URL(c.req.url).searchParams.get("cursor") ?? "";
  const result = await c.env.PLATFORM_DB.prepare(
    `SELECT hostname, space_id FROM portal_domains WHERE tenant_id = ? AND kind = 'domain' AND hostname > ?
      AND EXISTS (SELECT 1 FROM spaces s JOIN orgs o ON o.id = s.tenant_id AND o.status = 'active'
        WHERE s.id = portal_domains.space_id AND s.tenant_id = portal_domains.tenant_id AND s.status = 'active')
      ORDER BY hostname LIMIT 101`
  ).bind(tenantId, cursor).all<{ hostname: string; space_id: string }>();
  const hasMore = result.results.length > 100;
  const rows = result.results.slice(0, 100);
  return c.json({ data: rows.map((row) => ({ domain: row.hostname, space_id: row.space_id, status: "active" })), cursor: hasMore ? rows.at(-1)?.hostname ?? null : null, has_more: hasMore });
});

// DELETE /v1/domains/:domain — remove a custom domain mapping
app.delete("/v1/domains/:domain", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const domain = c.req.param("domain");

  const deleted = await c.env.PLATFORM_DB.prepare("DELETE FROM portal_domains WHERE kind = 'domain' AND hostname = ? AND tenant_id = ?")
    .bind(domain, tenantId).run();
  if (deleted.meta.changes === 0) return c.json({ error_code: "not_found", message: "Domain not found" }, 404);
  return c.json({ deleted: true });
});

// DELETE /v1/subdomains/:subdomain — remove a subdomain mapping
app.delete("/v1/subdomains/:subdomain", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const subdomain = c.req.param("subdomain");

  const deleted = await c.env.PLATFORM_DB.prepare("DELETE FROM portal_domains WHERE kind = 'subdomain' AND hostname = ? AND tenant_id = ?")
    .bind(subdomain, tenantId).run();
  if (deleted.meta.changes === 0) return c.json({ error_code: "not_found", message: "Subdomain not found" }, 404);
  return c.json({ deleted: true });
});

/** Resolve a product-portal host to its atomically reserved tenant/Space record. */
async function resolvePortal(host: string, env: Env): Promise<DomainMapping | null> {
  const normalizedHost = host.toLowerCase().replace(/:\d+$/, "");

  // 1. Check exact custom domain first (higher priority)
  const custom = await env.PLATFORM_DB.prepare(
    `SELECT tenant_id, space_id FROM portal_domains WHERE kind = 'domain' AND hostname = ?
      AND EXISTS (SELECT 1 FROM spaces s JOIN orgs o ON o.id = s.tenant_id AND o.status = 'active'
        WHERE s.id = portal_domains.space_id AND s.tenant_id = portal_domains.tenant_id AND s.status = 'active')`
  ).bind(normalizedHost).first<{ tenant_id: string; space_id: string }>();
  if (custom) return { tenantId: custom.tenant_id, spaceId: custom.space_id };
  // 2. Fallback to subdomain lookup
  // Never let a first-label match on an unrelated/custom hostname select a tenant.
  const ownedSuffix = ".naelao.app";
  if (normalizedHost.endsWith(ownedSuffix)) {
    const subdomain = normalizedHost.slice(0, -ownedSuffix.length);
    if (!subdomain || subdomain.includes(".")) return null;
    const mapping = await env.PLATFORM_DB.prepare(
      `SELECT tenant_id, space_id FROM portal_domains WHERE kind = 'subdomain' AND hostname = ?
        AND EXISTS (SELECT 1 FROM spaces s JOIN orgs o ON o.id = s.tenant_id AND o.status = 'active'
          WHERE s.id = portal_domains.space_id AND s.tenant_id = portal_domains.tenant_id AND s.status = 'active')`
    ).bind(subdomain).first<{ tenant_id: string; space_id: string }>();
    if (mapping) return { tenantId: mapping.tenant_id, spaceId: mapping.space_id };
  }
  return null;
}

/** Proxy the incoming request to the portal CF Pages origin with space context injected. */
function proxyToPortal(c: Context<{ Bindings: Env }>, mapping: DomainMapping, host: string): Response | Promise<Response> {
  const originalUrl = new URL(c.req.url);
  const portalOrigin = new URL(c.env.PORTAL_ORIGIN);
  originalUrl.hostname = portalOrigin.hostname;
  originalUrl.protocol = portalOrigin.protocol;
  originalUrl.port = portalOrigin.port;

  const upstreamHeaders = new Headers(c.req.raw.headers);
  upstreamHeaders.set("x-naelao-space-id", mapping.spaceId);
  upstreamHeaders.set("x-naelao-tenant-id", mapping.tenantId);
  upstreamHeaders.set("x-naelao-portal-host", host);

  return fetch(new Request(originalUrl.toString(), {
    method: c.req.method,
    headers: upstreamHeaders,
    body: c.req.raw.body,
    redirect: "follow",
  }));
}

// GET / — route verified product-portal domains. Storefront and checkout routes were removed;
// domain-specific commerce belongs to installed extensions or connected services.
app.get("/", async (c) => {
  const host = c.req.header("host") ?? "";
  const portal = await resolvePortal(host, c.env);
  if (portal) return proxyToPortal(c, portal, host);
  return c.html("<h1>Not found</h1>", 404);
});

// ALL /proxy — explicit product-portal ingress (kept for direct/rewritten routing).
// In production this worker sits behind *.naelao.app and any verified custom domains.
app.all("/proxy", async (c) => {
  const host = c.req.header("host") ?? "";
  const mapping = await resolvePortal(host, c.env);
  if (!mapping) {
    return c.json({ error_code: "not_found", message: "Portal not found for this domain" }, 404);
  }
  return proxyToPortal(c, mapping, host);
});

app.onError((err, c) => errorResponse(err, c.get("requestId") ?? "unknown"));

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
