// Portal Router — subdomain + custom-domain routing for Space end-user portals
import { Hono, type Context } from "hono";
import { errorResponse, requestId, mintInternalToken, readBoundedRequestText, readBoundedResponseText, RequestBodyTooLargeError, requireInternalHmac } from "@naelao/http";

interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  PORTAL_ORIGIN: string;
  PLATFORM_DB: D1Database;
  /** Billing worker — storefront buy/join buttons initiate the (reserved) money-in checkout. */
  BILLING_WORKER?: Fetcher;
}

interface StorefrontProduct {
  id: string;
  name: string;
  description: string;
  price_cents: number;
  currency: string;
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
    `SELECT 1 FROM business_services bs
      JOIN spaces s ON s.id = bs.space_id AND s.tenant_id = bs.tenant_id AND s.status = 'active'
      JOIN orgs o ON o.id = bs.tenant_id AND o.status = 'active'
      WHERE bs.tenant_id = ? AND bs.space_id = ? AND bs.kind = 'custom_domain'
        AND bs.custom_domain = ? AND bs.status = 'active'`
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

// ── Storefront (spec §11) — the multitenant CF-for-SaaS surface ──────────────
// This Worker is the fallback origin: all storefront hostnames (the {slug}.naelao.com
// wildcard + opt-in custom hostnames) route here and are resolved by Host header against
// business_services. The Worker renders the storefront and initiates checkout; money-in
// always goes through the billing worker (Naelao's Lemon Squeezy store + platform fee).

/** Resolve the storefront's space from a Host header via business_services. */
async function resolveStorefront(
  host: string,
  env: Env
): Promise<{ spaceId: string; tenantId: string } | null> {
  const row = await env.PLATFORM_DB.prepare(
    `SELECT bs.space_id, bs.tenant_id FROM business_services bs
      JOIN spaces s ON s.id = bs.space_id AND s.tenant_id = bs.tenant_id AND s.status = 'active'
      JOIN orgs o ON o.id = bs.tenant_id AND o.status = 'active'
      WHERE bs.status = 'active'
        AND ((bs.kind = 'storefront' AND bs.naelao_handle = ?1) OR (bs.kind = 'custom_domain' AND bs.custom_domain = ?1))
      LIMIT 1`
  ).bind(host).first<{ space_id: string; tenant_id: string }>();
  return row ? { spaceId: row.space_id, tenantId: row.tenant_id } : null;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2 }).format(cents / 100);
}

interface StorefrontBrand {
  brandColor?: string | undefined;
  tagline?: string | undefined;
}

function renderStorefront(spaceName: string, products: StorefrontProduct[], brand: StorefrontBrand = {}): string {
  const brandColor = brand.brandColor ?? "";
  const accent = /^#[0-9a-fA-F]{6}$/.test(brandColor) ? brandColor : "#4f46e5";
  const cards = products.length === 0
    ? `<div class="empty"><p>This store is opening soon.</p><span>No products are available yet — check back shortly.</span></div>`
    : products.map((p) => {
        const free = p.price_cents === 0;
        return `
      <article class="card">
        <div class="card-body">
          <h3>${esc(p.name)}</h3>
          ${p.description ? `<p class="desc">${esc(p.description)}</p>` : ""}
        </div>
        <div class="row">
          <span class="price">${free ? "Free" : money(p.price_cents, p.currency)}</span>
          <form method="POST" action="/storefront/checkout">
            <input type="hidden" name="product_id" value="${esc(p.id)}" />
            <button type="submit">${free ? "Get it" : "Buy"}</button>
          </form>
        </div>
      </article>`;
      }).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="index,follow" />
<title>${esc(spaceName)}</title>
<style>
  :root{--brand:${accent};--bg:#f6f7fb;--ink:#0f172a;--muted:#64748b;--line:#e6e8ee}
  *{box-sizing:border-box}html,body{margin:0}
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Inter,sans-serif;background:var(--bg);color:var(--ink);line-height:1.5}
  header{padding:64px 24px 56px;text-align:center;background:
    radial-gradient(1200px 400px at 50% -120px, color-mix(in srgb, var(--brand) 16%, white), transparent), #fff;
    border-bottom:1px solid var(--line)}
  header h1{margin:0;font-size:clamp(26px,5vw,38px);letter-spacing:-.02em}
  header p{margin:10px auto 0;max-width:560px;color:var(--muted);font-size:15px}
  main{max-width:960px;margin:-28px auto 0;padding:0 24px 48px;
    display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,260px),1fr));gap:18px}
  .card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:22px;display:flex;flex-direction:column;
    box-shadow:0 1px 2px rgba(15,23,42,.04);transition:box-shadow .15s,transform .15s}
  .card:hover{box-shadow:0 8px 24px rgba(15,23,42,.08);transform:translateY(-2px)}
  .card-body{flex:1}.card h3{margin:0 0 8px;font-size:17px}
  .desc{color:var(--muted);font-size:14px;margin:0}
  .row{display:flex;align-items:center;justify-content:space-between;margin-top:18px;gap:12px}
  .price{font-weight:700;font-size:18px}
  button{background:var(--brand);color:#fff;border:0;border-radius:10px;padding:9px 20px;font-weight:600;font-size:14px;cursor:pointer}
  button:hover{filter:brightness(.95)}
  .empty{grid-column:1/-1;text-align:center;color:var(--muted);padding:64px 24px;background:#fff;border:1px dashed var(--line);border-radius:16px}
  .empty p{font-weight:600;color:var(--ink);margin:0 0 6px}.empty span{font-size:14px}
  footer{text-align:center;color:#94a3b8;font-size:12px;padding:28px}
  footer a{color:inherit}
</style></head>
<body>
  <header>
    <h1>${esc(spaceName)}</h1>
    ${brand.tagline ? `<p>${esc(brand.tagline)}</p>` : ""}
  </header>
  <main>${cards}</main>
  <footer>Powered by <a href="https://naelao.com">Naelao</a></footer>
</body></html>`;
}

/**
 * Render the storefront for an already-resolved space. Shared by the explicit `/storefront`
 * path and the root-path handler (the address a buyer's browser actually lands on when a
 * storefront host CNAMEs to this Worker as the Cloudflare-for-SaaS fallback origin).
 */
async function renderStorefrontForSpace(
  c: Context<{ Bindings: Env }>,
  sf: { spaceId: string; tenantId: string }
): Promise<Response> {
  const space = await c.env.PLATFORM_DB.prepare(
    `SELECT s.name, s.config_json FROM spaces s JOIN orgs o ON o.id = s.tenant_id AND o.status = 'active'
      WHERE s.id = ? AND s.tenant_id = ? AND s.status = 'active'`
  ).bind(sf.spaceId, sf.tenantId).first<{ name: string; config_json: string | null }>();
  if (!space) return c.html("<h1>Store not found</h1>", 404);
  const { results } = await c.env.PLATFORM_DB.prepare(
    `SELECT p.id, substr(p.name, 1, 200) AS name, substr(p.description, 1, 2000) AS description, p.price_cents, p.currency FROM launchpad_products p
      JOIN spaces s ON s.id = p.space_id AND s.tenant_id = ? AND s.status = 'active'
      JOIN orgs o ON o.id = s.tenant_id AND o.status = 'active'
      WHERE p.space_id = ? AND p.status = 'published' ORDER BY p.created_at DESC LIMIT 100`
  ).bind(sf.tenantId, sf.spaceId).all<StorefrontProduct>();

  // Optional storefront branding from the space config (brand_color / tagline).
  let brand: StorefrontBrand = {};
  if (space?.config_json) {
    try {
      const cfg = JSON.parse(space.config_json) as { brand_color?: string; tagline?: string; storefront?: { brand_color?: string; tagline?: string } };
      brand = {
        brandColor: cfg.storefront?.brand_color ?? cfg.brand_color,
        tagline: cfg.storefront?.tagline ?? cfg.tagline,
      };
    } catch { /* ignore malformed config */ }
  }

  return c.html(renderStorefront(space?.name ?? "Store", results, brand));
}

// GET /storefront — render the storefront for the requesting Host.
app.get("/storefront", async (c) => {
  const host = c.req.header("host") ?? "";
  const sf = await resolveStorefront(host, c.env);
  if (!sf) return c.html("<h1>Store not found</h1>", 404);
  return renderStorefrontForSpace(c, sf);
});

// POST /storefront/checkout — initiate a (reserved) money-in checkout for a product.
// Accepts form posts from the rendered storefront; redirects the buyer to Lemon Squeezy.
app.post("/storefront/checkout", async (c) => {
  const host = c.req.header("host") ?? "";
  const sf = await resolveStorefront(host, c.env);
  if (!sf) return c.json({ error_code: "not_found", message: "Store not found" }, 404);
  if (!c.env.BILLING_WORKER) return c.json({ error_code: "unavailable", message: "checkout unavailable" }, 503);

  let formText: string;
  try { formText = await readBoundedRequestText(c.req.raw, 16 * 1024); }
  catch (err) {
    if (err instanceof RequestBodyTooLargeError) return c.json({ error_code: "payload_too_large" }, 413);
    return c.json({ error_code: "bad_request", message: "Invalid checkout form" }, 400);
  }
  const form = new URLSearchParams(formText);
  const productId = form.get("product_id") ?? "";
  const emailValue = form.get("email") ?? "";
  const email = emailValue || undefined;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(productId)) return c.json({ error_code: "bad_request", message: "Valid product_id is required" }, 400);
  if (email && (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    return c.json({ error_code: "bad_request", message: "Invalid email" }, 400);
  }
  if (!await isActiveTenantSpace(c.env.PLATFORM_DB, sf.tenantId, sf.spaceId)) return c.json({ error_code: "not_found", message: "Store not found" }, 404);

  // The portal is a trusted server-side caller; money-in still flows through the billing
  // worker's reserved commerce checkout so the platform fee is applied.
  // S0.6: /internal/commerce/checkout now requires requireInternalHmac (A1.16.25) — this call
  // still sent the old static, forgeable "x-naelao-internal: commerce-script" string, which
  // would 403 unconditionally, silently breaking the storefront checkout path entirely. Mint a
  // real internal token like every other direct-service-binding caller does.
  const commerceToken = await mintInternalToken(c.env.PLATFORM_SECRET, sf.tenantId);
  const resp = await c.env.BILLING_WORKER.fetch(
    new Request("http://billing-worker/internal/commerce/checkout", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": sf.tenantId, "x-naelao-internal-token": commerceToken },
      body: JSON.stringify({ space_id: sf.spaceId, product_id: productId, ...(email ? { customer_email: email } : {}) }),
      signal: AbortSignal.timeout(20_000),
    })
  );
  if (!resp.ok) return c.json({ error_code: "checkout_failed", message: (await readBoundedResponseText(resp, 8 * 1024).catch(() => "Checkout failed")).slice(0, 300) }, 502);
  let checkoutUrl = "";
  try {
    const parsed = JSON.parse(await readBoundedResponseText(resp, 16 * 1024)) as { checkout_url?: unknown };
    if (typeof parsed.checkout_url === "string" && parsed.checkout_url.length <= 2_048) {
      const url = new URL(parsed.checkout_url);
      if (url.protocol === "https:" && !url.username && !url.password) checkoutUrl = url.toString();
    }
  } catch { /* reject malformed or oversized billing responses below */ }
  if (!checkoutUrl) return c.json({ error_code: "checkout_failed", message: "Billing returned an invalid checkout URL" }, 502);
  return c.redirect(checkoutUrl, 303);
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

// GET / — the address a buyer's browser actually lands on. This Worker is the Cloudflare-for-SaaS
// fallback origin: storefront hosts ({slug}.naelao.com wildcard + verified custom hostnames) and
// product-portal hosts (*.naelao.app + portal custom domains) all arrive here at the root path.
// Storefront takes precedence (business_services), then the product portal (PORTAL_DOMAINS).
app.get("/", async (c) => {
  const host = c.req.header("host") ?? "";
  const sf = await resolveStorefront(host, c.env);
  if (sf) return renderStorefrontForSpace(c, sf);

  const portal = await resolvePortal(host, c.env);
  if (portal) return proxyToPortal(c, portal, host);

  return c.html("<h1>Store not found</h1>", 404);
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
