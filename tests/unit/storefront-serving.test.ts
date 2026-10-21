import { describe, it, expect } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { storefront } from "../../workers/agents/src/script-engine/prebuilt/storefront.js";
import type { PrebuiltOpContext } from "../../workers/agents/src/script-engine/prebuilt/index.js";
import portalRouter from "../../workers/portal-router/src/index.js";

// #1 Storefront render + Cloudflare-for-SaaS apply step. Two invariants are locked here:
//   1. storefront.set_custom_domain must post kind='custom_domain' — that is the ONLY branch
//      on the spaces worker that runs createCustomHostname (the CF-for-SaaS apply). Posting
//      kind='storefront' silently drops the domain and allocates a {slug}.naelao.com handle.
//   2. The portal Worker (the CF-for-SaaS fallback origin) must serve the store at the ROOT
//      path a buyer's browser actually lands on — not only at the explicit /storefront path.

// ── Prebuilt: the custom-domain kind is what triggers the apply step ─────────────
describe("storefront prebuilt — business-service kinds", () => {
  function captureCtx(): { ctx: PrebuiltOpContext; sent: Array<{ path: string; body: Record<string, unknown> }> } {
    const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
    const spacesWorker = {
      async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url);
        const body = req.method === "POST" ? ((await req.json()) as Record<string, unknown>) : {};
        sent.push({ path: url.pathname, body });
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      },
    };
    const ctx = {
      env: { spaceId: "space-1", tenantId: "tenant-1", spacesWorker, platformSecret: "test-platform-secret" },
      run: async () => ({}),
    } as unknown as PrebuiltOpContext;
    return { ctx, sent };
  }

  it("set_custom_domain posts kind='custom_domain' (the CF-for-SaaS apply branch)", async () => {
    const { ctx, sent } = captureCtx();
    await storefront.operations["storefront.set_custom_domain"]?.({ domain: "shop.example.com" }, ctx);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body.kind).toBe("custom_domain");
    expect(sent[0]?.body.custom_domain).toBe("shop.example.com");
    // Regression: it must NOT go down the storefront-handle branch.
    expect(sent[0]?.body.kind).not.toBe("storefront");
  });

  it("provision posts kind='storefront' with a DNS-safe slug", async () => {
    const { ctx, sent } = captureCtx();
    await storefront.operations["storefront.provision"]?.({ name: "My Cool Shop!" }, ctx);
    expect(sent[0]?.body.kind).toBe("storefront");
    expect(sent[0]?.body.slug).toBe("my-cool-shop");
  });
});

// ── Portal Worker: serve the store at the root path (the fallback origin) ────────
interface FakeRows {
  biz?: { space_id: string; tenant_id: string } | null;
  space?: { name: string; config_json: string | null } | null;
  products?: Array<{ id: string; name: string; description: string; price_cents: number; currency: string }>;
  queries?: string[];
  portalMappings?: Record<string, string>;
}

function fakeEnv(rows: FakeRows): Record<string, unknown> {
  const db = {
    prepare(sql: string) {
      rows.queries?.push(sql);
      return {
        bind(...values: unknown[]) {
          return {
            async first() {
              if (sql.includes("FROM portal_domains")) {
                if (sql.includes("EXISTS") && !rows.space) return null;
                const fixedKind = sql.includes("kind = 'domain'") ? "domain" : sql.includes("kind = 'subdomain'") ? "subdomain" : null;
                const kind = fixedKind ?? values[0];
                const hostname = fixedKind ? values[0] : values[1];
                const prefix = kind === "domain" ? "domain:" : "subdomain:";
                const raw = rows.portalMappings?.[`${prefix}${String(hostname)}`];
                if (!raw) return null;
                try {
                  const mapping = JSON.parse(raw) as { tenantId: string; spaceId: string };
                  return { tenant_id: mapping.tenantId, space_id: mapping.spaceId };
                } catch { return null; }
              }
              if (sql.includes("FROM business_services")) return rows.biz ?? null;
              if (sql.includes("FROM spaces")) return rows.space ?? null;
              return null;
            },
            async all() {
              if (sql.includes("FROM launchpad_products")) return { results: rows.products ?? [] };
              if (sql.includes("FROM portal_domains")) {
                const [tenantId, cursor] = values.map(String);
                const results = Object.entries(rows.portalMappings ?? []).flatMap(([key, raw]) => {
                  if (!key.startsWith("domain:")) return [];
                  try {
                    const mapping = JSON.parse(raw) as { tenantId: string; spaceId: string };
                    const hostname = key.slice("domain:".length);
                    return mapping.tenantId === tenantId && hostname > cursor ? [{ hostname, space_id: mapping.spaceId }] : [];
                  } catch { return []; }
                }).sort((a, b) => a.hostname.localeCompare(b.hostname)).slice(0, 101);
                return { results };
              }
              return { results: [] };
            },
            async run() {
              if (sql.includes("INSERT INTO portal_domains")) {
                const [kind, hostname, tenantId, spaceId] = values.map(String);
                const key = `${kind === "domain" ? "domain" : "subdomain"}:${hostname}`;
                if (!rows.portalMappings?.[key] && rows.portalMappings) rows.portalMappings[key] = JSON.stringify({ spaceId, tenantId });
                return { meta: { changes: 1 } };
              }
              if (sql.includes("DELETE FROM portal_domains")) {
                const [kind, hostname, tenantId] = values.map(String);
                const key = `${kind === "domain" ? "domain" : "subdomain"}:${hostname}`;
                const raw = rows.portalMappings?.[key];
                if (raw && rows.portalMappings) {
                  const mapping = JSON.parse(raw) as { tenantId: string };
                  if (mapping.tenantId === tenantId) {
                    delete rows.portalMappings[key];
                    return { meta: { changes: 1 } };
                  }
                }
                return { meta: { changes: 0 } };
              }
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  return { PLATFORM_SECRET: "test-secret", PORTAL_ORIGIN: "https://portal.naelao.app", ENVIRONMENT: "test", PLATFORM_DB: db };
}

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function rootRequest(host: string): Request {
  return new Request(`https://${host}/`, { headers: { host } });
}

describe("portal Worker — storefront at the root path", () => {
  it("renders the store for a storefront host at GET /", async () => {
    const env = fakeEnv({
      biz: { space_id: "space-1", tenant_id: "tenant-1" },
      space: { name: "Aria's Studio", config_json: null },
      products: [{ id: "p1", name: "Watercolor Course", description: "Learn to paint", price_cents: 4900, currency: "USD" }],
    });
    const res = await portalRouter.fetch(rootRequest("aria-abc123.naelao.com"), env as never, execCtx);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Aria&#39;s Studio".replace("&#39;", "'")); // name is escaped in the title
    expect(html).toContain("Watercolor Course");
    expect(html).toContain("$49.00");
    expect(html.match(/<header>/g)).toHaveLength(1);
    // The buy form points back at the same-host checkout the Worker also handles.
    expect(html).toContain('action="/storefront/checkout"');
  });

  it("renders an 'opening soon' empty state when the store has no published products", async () => {
    const env = fakeEnv({
      biz: { space_id: "space-2", tenant_id: "tenant-1" },
      space: { name: "Empty Store", config_json: null },
      products: [],
    });
    const res = await portalRouter.fetch(rootRequest("empty-xyz.naelao.com"), env as never, execCtx);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("opening soon");
  });

  it("returns 404 at / when the host resolves to neither a storefront nor a portal", async () => {
    const env = fakeEnv({ biz: null });
    const res = await portalRouter.fetch(rootRequest("nobody.example.com"), env as never, execCtx);
    expect(res.status).toBe(404);
  });

  it("queries only active storefronts owned by active tenants", async () => {
    const rows: FakeRows = { biz: null, queries: [] };
    const res = await portalRouter.fetch(rootRequest("paused-abc.naelao.com"), fakeEnv(rows) as never, execCtx);
    expect(res.status).toBe(404);
    expect(rows.queries?.[0]).toContain("s.status = 'active'");
    expect(rows.queries?.[0]).toContain("o.status = 'active'");
  });

  it("blocks caller-forged domain management headers without an internal HMAC", async () => {
    const env = fakeEnv({});
    const res = await portalRouter.fetch(new Request("https://portal.test/v1/domains", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "victim-tenant" },
      body: JSON.stringify({ domain: "victim.example.com", space_id: "victim-space" }),
    }), env as never, execCtx);
    expect(res.status).toBe(403);
  });

  it("rejects reserved subdomains after authenticating the internal management caller", async () => {
    const env = fakeEnv({});
    const token = await mintInternalToken("test-secret", "tenant-1");
    const res = await portalRouter.fetch(new Request("https://portal.test/v1/subdomains", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
      body: JSON.stringify({ subdomain: "api", space_id: "space-1" }),
    }), env as never, execCtx);
    expect(res.status).toBe(400);
  });

  it("registers domains only for an active Space owned by the HMAC tenant", async () => {
    const rows: FakeRows = { space: { name: "Store", config_json: null }, biz: { space_id: "space-1", tenant_id: "tenant-1" }, portalMappings: {} };
    const env = fakeEnv(rows);
    const token = await mintInternalToken("test-secret", "tenant-1");
    const res = await portalRouter.fetch(new Request("https://portal.test/v1/domains", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
      body: JSON.stringify({ domain: "shop.example.com", space_id: "space-1" }),
    }), env as never, execCtx);
    expect(res.status).toBe(201);
    expect(rows.portalMappings?.["domain:shop.example.com"]).toBe(JSON.stringify({ spaceId: "space-1", tenantId: "tenant-1" }));
  });

  it("does not let another tenant overwrite an existing subdomain reservation", async () => {
    const rows: FakeRows = {
      space: { name: "Other Store", config_json: null },
      portalMappings: { "subdomain:shop": JSON.stringify({ spaceId: "space-a", tenantId: "tenant-a" }) },
    };
    const env = fakeEnv(rows);
    const token = await mintInternalToken("test-secret", "tenant-b");
    const res = await portalRouter.fetch(new Request("https://portal.test/v1/subdomains", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-b", "x-naelao-internal-token": token },
      body: JSON.stringify({ subdomain: "shop", space_id: "space-b" }),
    }), env as never, execCtx);
    expect(res.status).toBe(409);
    expect(rows.portalMappings?.["subdomain:shop"]).toBe(JSON.stringify({ spaceId: "space-a", tenantId: "tenant-a" }));
  });

  it("requires a verified active custom hostname before registering a portal mapping", async () => {
    const rows: FakeRows = { space: { name: "Store", config_json: null }, biz: null, portalMappings: {} };
    const env = fakeEnv(rows);
    const token = await mintInternalToken("test-secret", "tenant-1");
    const res = await portalRouter.fetch(new Request("https://portal.test/v1/domains", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
      body: JSON.stringify({ domain: "unverified.example.com", space_id: "space-1" }),
    }), env as never, execCtx);
    expect(res.status).toBe(409);
    expect(rows.portalMappings?.["domain:unverified.example.com"]).toBeUndefined();
  });

  it("lists domain mappings from KV rather than querying the nonexistent space_domains table", async () => {
    const rows: FakeRows = { space: { name: "Store", config_json: null }, portalMappings: { "domain:shop.example.com": JSON.stringify({ spaceId: "space-1", tenantId: "tenant-1" }) }, queries: [] };
    const env = fakeEnv(rows);
    const token = await mintInternalToken("test-secret", "tenant-1");
    const res = await portalRouter.fetch(new Request("https://portal.test/v1/domains", {
      headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
    }), env as never, execCtx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: [{ domain: "shop.example.com", space_id: "space-1" }] });
    expect(rows.queries?.some((query) => query.includes("space_domains"))).toBe(false);
  });

  it("does not proxy a portal mapping after its Space becomes inactive", async () => {
    const rows: FakeRows = { biz: null, space: null, portalMappings: { "domain:custom.example.com": JSON.stringify({ spaceId: "space-gone", tenantId: "tenant-gone" }) } };
    const res = await portalRouter.fetch(rootRequest("custom.example.com"), fakeEnv(rows) as never, execCtx);
    expect(res.status).toBe(404);
  });

  it("does not resolve a Naelao subdomain mapping on an unrelated host", async () => {
    const rows: FakeRows = {
      space: { name: "Tenant Portal", config_json: null },
      portalMappings: { "subdomain:shop": JSON.stringify({ spaceId: "space-1", tenantId: "tenant-1" }) },
    };
    const res = await portalRouter.fetch(rootRequest("shop.attacker.example"), fakeEnv(rows) as never, execCtx);
    expect(res.status).toBe(404);
  });

  it("rejects checkout response URLs outside HTTPS before redirecting", async () => {
    const env = fakeEnv({ biz: { space_id: "space-1", tenant_id: "tenant-1" }, space: { name: "Store", config_json: null } }) as Record<string, unknown>;
    env.BILLING_WORKER = { fetch: async () => Response.json({ checkout_url: "javascript:alert(1)" }) };
    const res = await portalRouter.fetch(new Request("https://store.naelao.com/storefront/checkout", {
      method: "POST",
      headers: { host: "store.naelao.com", "content-type": "application/x-www-form-urlencoded" },
      body: "product_id=product_1",
    }), env as never, execCtx);
    expect(res.status).toBe(502);
    expect(res.headers.get("location")).toBeNull();
  });

  it("rejects an oversized checkout form before contacting billing", async () => {
    const env = fakeEnv({ biz: { space_id: "space-1", tenant_id: "tenant-1" }, space: { name: "Store", config_json: null } }) as Record<string, unknown>;
    let called = false;
    env.BILLING_WORKER = { fetch: async () => { called = true; return Response.json({ checkout_url: "https://checkout.naelao.com" }); } };
    const res = await portalRouter.fetch(new Request("https://store.naelao.com/storefront/checkout", {
      method: "POST",
      headers: { host: "store.naelao.com", "content-type": "application/x-www-form-urlencoded" },
      body: `product_id=product_1&padding=${"x".repeat(17 * 1024)}`,
    }), env as never, execCtx);
    expect(res.status).toBe(413);
    expect(called).toBe(false);
  });
});
