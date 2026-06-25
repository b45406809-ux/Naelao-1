// Portal Router — subdomain + custom-domain routing for Space end-user portals
import { Hono } from "hono";
import { errorResponse, requestId } from "@naelao/http";

interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  PORTAL_ORIGIN: string;
  PORTAL_DOMAINS: KVNamespace;
  PLATFORM_DB: D1Database;
}

interface DomainMapping {
  spaceId: string;
  tenantId: string;
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

// POST /v1/domains — register a custom domain for a Space
app.post("/v1/domains", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);

  const body = await c.req.json<{ domain: string; space_id: string }>();
  if (!body.domain || !body.space_id) {
    return c.json({ error_code: "bad_request", message: "domain and space_id required" }, 400);
  }

  // Basic domain format validation (lowercase alphanumeric, hyphens, dots)
  if (!/^[a-z0-9][a-z0-9.-]{0,253}[a-z0-9]$/.test(body.domain)) {
    return c.json({ error_code: "bad_request", message: "Invalid domain format" }, 400);
  }

  const value: DomainMapping = { spaceId: body.space_id, tenantId };
  await c.env.PORTAL_DOMAINS.put(`domain:${body.domain}`, JSON.stringify(value));

  return c.json({ domain: body.domain, space_id: body.space_id, status: "active" }, 201);
});

// POST /v1/subdomains — register a naelao.app subdomain for a Space
app.post("/v1/subdomains", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);

  const body = await c.req.json<{ subdomain: string; space_id: string }>();
  if (!body.subdomain || !body.space_id) {
    return c.json({ error_code: "bad_request", message: "subdomain and space_id required" }, 400);
  }

  // Subdomain: only lowercase alphanumeric + hyphens, 3-63 chars
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(body.subdomain)) {
    return c.json({ error_code: "bad_request", message: "Invalid subdomain format" }, 400);
  }

  const value: DomainMapping = { spaceId: body.space_id, tenantId };
  await c.env.PORTAL_DOMAINS.put(`subdomain:${body.subdomain}`, JSON.stringify(value));

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

// GET /v1/domains — list domains for tenant (from D1 authoritative store)
app.get("/v1/domains", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);

  const { results } = await c.env.PLATFORM_DB.prepare(
    "SELECT id, domain, space_id, status, created_at FROM space_domains WHERE tenant_id = ?"
  )
    .bind(tenantId)
    .all();

  return c.json({ data: results });
});

// DELETE /v1/domains/:domain — remove a custom domain mapping
app.delete("/v1/domains/:domain", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const domain = c.req.param("domain");

  // Verify ownership before deleting
  const raw = await c.env.PORTAL_DOMAINS.get(`domain:${domain}`);
  if (raw === null) {
    return c.json({ error_code: "not_found", message: "Domain not found" }, 404);
  }

  let existing: DomainMapping;
  try {
    existing = JSON.parse(raw) as DomainMapping;
  } catch {
    return c.json({ error_code: "internal_error", message: "Corrupt domain record" }, 500);
  }

  if (existing.tenantId !== tenantId) {
    return c.json({ error_code: "not_found", message: "Domain not found" }, 404);
  }

  await c.env.PORTAL_DOMAINS.delete(`domain:${domain}`);
  return c.json({ deleted: true });
});

// DELETE /v1/subdomains/:subdomain — remove a subdomain mapping
app.delete("/v1/subdomains/:subdomain", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const subdomain = c.req.param("subdomain");

  const raw = await c.env.PORTAL_DOMAINS.get(`subdomain:${subdomain}`);
  if (raw === null) {
    return c.json({ error_code: "not_found", message: "Subdomain not found" }, 404);
  }

  let existing: DomainMapping;
  try {
    existing = JSON.parse(raw) as DomainMapping;
  } catch {
    return c.json({ error_code: "internal_error", message: "Corrupt subdomain record" }, 500);
  }

  if (existing.tenantId !== tenantId) {
    return c.json({ error_code: "not_found", message: "Subdomain not found" }, 404);
  }

  await c.env.PORTAL_DOMAINS.delete(`subdomain:${subdomain}`);
  return c.json({ deleted: true });
});

// ALL /proxy — main ingress handler for incoming portal requests
// In production this worker sits behind *.naelao.app and any verified custom domains.
// The CF Zone routes to this worker; it resolves the Space and proxies to the Portal CF Pages app.
app.all("/proxy", async (c) => {
  const host = c.req.header("host") ?? "";
  // Derive subdomain label from host (e.g. "myspace" from "myspace.naelao.app")
  const subdomain = host.split(".")[0] ?? "";

  let spaceId: string | null = null;
  let resolvedTenantId: string | null = null;

  // 1. Check exact custom domain first (higher priority)
  const customRaw = await c.env.PORTAL_DOMAINS.get(`domain:${host}`);
  if (customRaw !== null) {
    try {
      const mapping = JSON.parse(customRaw) as DomainMapping;
      spaceId = mapping.spaceId;
      resolvedTenantId = mapping.tenantId;
    } catch {
      // Corrupt entry — fall through to subdomain check
    }
  }

  // 2. Fallback to subdomain lookup
  if (spaceId === null && subdomain) {
    const subRaw = await c.env.PORTAL_DOMAINS.get(`subdomain:${subdomain}`);
    if (subRaw !== null) {
      try {
        const mapping = JSON.parse(subRaw) as DomainMapping;
        spaceId = mapping.spaceId;
        resolvedTenantId = mapping.tenantId;
      } catch {
        // Corrupt entry — fall through
      }
    }
  }

  if (spaceId === null || resolvedTenantId === null) {
    return c.json({ error_code: "not_found", message: "Portal not found for this domain" }, 404);
  }

  // Proxy to portal CF Pages origin with Space context injected as headers
  const originalUrl = new URL(c.req.url);
  const portalOrigin = new URL(c.env.PORTAL_ORIGIN);
  originalUrl.hostname = portalOrigin.hostname;
  originalUrl.protocol = portalOrigin.protocol;
  originalUrl.port = portalOrigin.port;

  // Build a fresh headers object — spread raw request headers and inject space context
  const upstreamHeaders = new Headers(c.req.raw.headers);
  upstreamHeaders.set("x-naelao-space-id", spaceId);
  upstreamHeaders.set("x-naelao-tenant-id", resolvedTenantId);
  upstreamHeaders.set("x-naelao-portal-host", host);

  const proxyReq = new Request(originalUrl.toString(), {
    method: c.req.method,
    headers: upstreamHeaders,
    body: c.req.raw.body,
    redirect: "follow",
  });

  return fetch(proxyReq);
});

app.onError((err, c) => errorResponse(err, c.get("requestId") ?? "unknown"));

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
