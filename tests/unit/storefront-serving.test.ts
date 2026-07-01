import { describe, it, expect } from "vitest";
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
      env: { spaceId: "space-1", tenantId: "tenant-1", spacesWorker },
      run: async () => ({}),
    } as unknown as PrebuiltOpContext;
    return { ctx, sent };
  }

  it("set_custom_domain posts kind='custom_domain' (the CF-for-SaaS apply branch)", async () => {
    const { ctx, sent } = captureCtx();
    await storefront.operations["storefront.set_custom_domain"]!({ domain: "shop.example.com" }, ctx);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body["kind"]).toBe("custom_domain");
    expect(sent[0]!.body["custom_domain"]).toBe("shop.example.com");
    // Regression: it must NOT go down the storefront-handle branch.
    expect(sent[0]!.body["kind"]).not.toBe("storefront");
  });

  it("provision posts kind='storefront' with a DNS-safe slug", async () => {
    const { ctx, sent } = captureCtx();
    await storefront.operations["storefront.provision"]!({ name: "My Cool Shop!" }, ctx);
    expect(sent[0]!.body["kind"]).toBe("storefront");
    expect(sent[0]!.body["slug"]).toBe("my-cool-shop");
  });
});

// ── Portal Worker: serve the store at the root path (the fallback origin) ────────
interface FakeRows {
  biz?: { space_id: string; tenant_id: string } | null;
  space?: { name: string; config_json: string | null } | null;
  products?: Array<{ id: string; name: string; description: string; price_cents: number; currency: string }>;
}

function fakeEnv(rows: FakeRows): Record<string, unknown> {
  const db = {
    prepare(sql: string) {
      return {
        bind() {
          return {
            async first() {
              if (sql.includes("FROM business_services")) return rows.biz ?? null;
              if (sql.includes("FROM spaces")) return rows.space ?? null;
              return null;
            },
            async all() {
              if (sql.includes("FROM launchpad_products")) return { results: rows.products ?? [] };
              return { results: [] };
            },
          };
        },
      };
    },
  };
  const kv = { async get() { return null; }, async put() {}, async delete() {} };
  return { PLATFORM_SECRET: "test-secret", PORTAL_ORIGIN: "https://portal.naelao.app", ENVIRONMENT: "test", PLATFORM_DB: db, PORTAL_DOMAINS: kv };
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
});
