// Portal Router — subdomain + custom-domain routing for Space end-user portals
import { Hono } from "hono";
import { errorResponse, requestId } from "@naelao/http";

interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  PORTAL_ORIGIN: string;
  PORTAL_DOMAINS: KVNamespace;
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
    `SELECT space_id, tenant_id FROM business_services
      WHERE status IN ('active','pending_dns')
        AND ((kind = 'storefront' AND naelao_handle = ?1) OR (kind = 'custom_domain' AND custom_domain = ?1))
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

function renderStorefront(spaceName: string, products: StorefrontProduct[]): string {
  const cards = products.length === 0
    ? `<p class="empty">This store has no products yet.</p>`
    : products.map((p) => `
      <div class="card">
        <h3>${esc(p.name)}</h3>
        <p class="desc">${esc(p.description)}</p>
        <div class="row">
          <span class="price">${money(p.price_cents, p.currency)}</span>
          <form method="POST" action="/storefront/checkout">
            <input type="hidden" name="product_id" value="${esc(p.id)}" />
            <button type="submit">Buy</button>
          </form>
        </div>
      </div>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(spaceName)}</title>
<style>
  :root{--brand:#4f46e5}
  *{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;color:#0f172a}
  header{padding:48px 24px;text-align:center;background:#fff;border-bottom:1px solid #e2e8f0}
  header h1{margin:0;font-size:28px}
  main{max-width:880px;margin:0 auto;padding:32px 24px;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:20px}
  .card{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:20px;display:flex;flex-direction:column}
  .card h3{margin:0 0 6px}.desc{color:#64748b;font-size:14px;flex:1}
  .row{display:flex;align-items:center;justify-content:space-between;margin-top:16px}
  .price{font-weight:700;font-size:18px}
  button{background:var(--brand);color:#fff;border:0;border-radius:8px;padding:8px 18px;font-weight:600;cursor:pointer}
  .empty{grid-column:1/-1;text-align:center;color:#94a3b8;padding:48px}
  footer{text-align:center;color:#94a3b8;font-size:12px;padding:24px}
</style></head>
<body>
  <header><h1>${esc(spaceName)}</h1></header>
  <main>${cards}</main>
  <footer>Powered by Naelao</footer>
</body></html>`;
}

// GET /storefront — render the storefront for the requesting Host.
app.get("/storefront", async (c) => {
  const host = c.req.header("host") ?? "";
  const sf = await resolveStorefront(host, c.env);
  if (!sf) return c.html("<h1>Store not found</h1>", 404);

  const space = await c.env.PLATFORM_DB.prepare(
    "SELECT name FROM spaces WHERE id = ?"
  ).bind(sf.spaceId).first<{ name: string }>();
  const { results } = await c.env.PLATFORM_DB.prepare(
    "SELECT id, name, description, price_cents, currency FROM launchpad_products WHERE space_id = ? AND status = 'published' ORDER BY created_at DESC LIMIT 100"
  ).bind(sf.spaceId).all<StorefrontProduct>();

  return c.html(renderStorefront(space?.name ?? "Store", results));
});

// POST /storefront/checkout — initiate a (reserved) money-in checkout for a product.
// Accepts form posts from the rendered storefront; redirects the buyer to Lemon Squeezy.
app.post("/storefront/checkout", async (c) => {
  const host = c.req.header("host") ?? "";
  const sf = await resolveStorefront(host, c.env);
  if (!sf) return c.json({ error_code: "not_found", message: "Store not found" }, 404);
  if (!c.env.BILLING_WORKER) return c.json({ error_code: "unavailable", message: "checkout unavailable" }, 503);

  const form = await c.req.parseBody();
  const productId = String(form["product_id"] ?? "");
  const email = form["email"] ? String(form["email"]) : undefined;
  if (!productId) return c.json({ error_code: "bad_request", message: "product_id is required" }, 400);

  // The portal is a trusted server-side caller; money-in still flows through the billing
  // worker's reserved commerce checkout so the platform fee is applied.
  const resp = await c.env.BILLING_WORKER.fetch(
    new Request("http://billing-worker/internal/commerce/checkout", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-internal": "commerce-script", "x-naelao-tenant-id": sf.tenantId },
      body: JSON.stringify({ space_id: sf.spaceId, product_id: productId, ...(email ? { customer_email: email } : {}) }),
    })
  );
  if (!resp.ok) return c.json({ error_code: "checkout_failed", message: await resp.text() }, 502);
  const { checkout_url } = await resp.json<{ checkout_url: string }>();
  return c.redirect(checkout_url, 303);
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
