import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import routerWorker from "../../workers/router/src/index.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

// Security audit follow-up: CORS_ALLOWLIST was one static platform-wide env var — fine for the
// two fixed platform frontends but can't scale to arbitrary per-builder custom domains, or even
// the platform's own {slug}.naelao.com product subdomains (which were never in the allowlist at
// all — apps/shell, the Product Shell every end user uses, would have been CORS-blocked in a
// real deployment). This exercises the dynamic resolver added to close that gap.

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const SPACES_TABLE_SQL = `
  CREATE TABLE spaces (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    name TEXT NOT NULL DEFAULT '', spacetype_id TEXT NOT NULL DEFAULT 'launchpad',
    config_json TEXT NOT NULL DEFAULT '{}', product_slug TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX idx_spaces_product_slug ON spaces(product_slug) WHERE product_slug IS NOT NULL;
`;
const BUSINESS_SERVICES_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0035_commerce.sql"), "utf8");

function extractBusinessServicesTable(sql: string): string {
  const start = sql.indexOf("CREATE TABLE IF NOT EXISTS business_services");
  const end = sql.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS idx_bizsvc_space_kind");
  return sql.slice(start, end);
}

function makeFakeKv() {
  const store = new Map<string, string>();
  return {
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string) { store.set(key, value); },
    store,
  };
}

function makeEnv(opts: { withDb?: boolean; withKv?: boolean } = {}) {
  const fakeDb = createFakeD1([SPACES_TABLE_SQL, extractBusinessServicesTable(BUSINESS_SERVICES_MIGRATION)]);
  const kv = makeFakeKv();
  return {
    ENVIRONMENT: "test",
    JWT_SECRET: "test-jwt-secret",
    PLATFORM_SECRET: "test-platform-secret",
    CORS_ALLOWLIST: "https://dashboard.naelao.com",
    ...(opts.withDb !== false ? { PLATFORM_DB: fakeDb } : {}),
    ...(opts.withKv !== false ? { CONFIG: kv } : {}),
    __db: fakeDb,
    __kv: kv,
  };
}

async function seedProduct(env: ReturnType<typeof makeEnv>, slug: string, status = "active") {
  await env.__db.prepare(
    "INSERT INTO spaces (id, tenant_id, status, product_slug) VALUES (?, 'tenant-1', ?, ?)"
  ).bind(crypto.randomUUID(), status, slug).run();
}

async function seedCustomDomain(env: ReturnType<typeof makeEnv>, domain: string, status = "active") {
  await env.__db.prepare(
    "INSERT INTO business_services (id, space_id, tenant_id, kind, custom_domain, status) VALUES (?, 'space-1', 'tenant-1', 'custom_domain', ?, ?)"
  ).bind(crypto.randomUUID(), domain, status).run();
}

function healthReq(origin: string) {
  return new Request("https://router.naelao.com/health", { headers: { origin } });
}

describe("router — dynamic CORS origin resolution", () => {
  it("allows a product's {slug}.naelao.com origin", async () => {
    const env = makeEnv();
    await seedProduct(env, "acme");
    const res = await routerWorker.fetch(healthReq("https://acme.naelao.com"), env as never, execCtx);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://acme.naelao.com");
  });

  it("does not allow a suspended/inactive product's subdomain", async () => {
    const env = makeEnv();
    await seedProduct(env, "acme", "suspended");
    const res = await routerWorker.fetch(healthReq("https://acme.naelao.com"), env as never, execCtx);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("does not allow an unregistered subdomain", async () => {
    const env = makeEnv();
    const res = await routerWorker.fetch(healthReq("https://ghost.naelao.com"), env as never, execCtx);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("allows an active custom domain from business_services", async () => {
    const env = makeEnv();
    await seedCustomDomain(env, "shop.example.com");
    const res = await routerWorker.fetch(healthReq("https://shop.example.com"), env as never, execCtx);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://shop.example.com");
  });

  it("does not allow a pending_dns (not yet active) custom domain", async () => {
    const env = makeEnv();
    await seedCustomDomain(env, "shop.example.com", "pending_dns");
    const res = await routerWorker.fetch(healthReq("https://shop.example.com"), env as never, execCtx);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("does not falsely match a sub-subdomain against a leaf slug (acme.evil.naelao.com != slug 'acme')", async () => {
    const env = makeEnv();
    await seedProduct(env, "acme.evil");
    const res = await routerWorker.fetch(healthReq("https://acme.evil.naelao.com"), env as never, execCtx);
    // product_slug 'acme.evil' can't exist as a DNS-valid single label anyway; the resolver's
    // own leaf-label check means "acme.evil" is never even attempted as a slug for this host.
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("caches a positive result in KV so a second lookup skips D1", async () => {
    const env = makeEnv();
    await seedProduct(env, "acme");
    await routerWorker.fetch(healthReq("https://acme.naelao.com"), env as never, execCtx);
    expect(env.__kv.store.get("cors:origin:acme.naelao.com")).toBe("1");

    // Delete the underlying row — a cached "1" should still allow it within the TTL window.
    await env.__db.prepare("DELETE FROM spaces WHERE product_slug = 'acme'").run();
    const res = await routerWorker.fetch(healthReq("https://acme.naelao.com"), env as never, execCtx);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://acme.naelao.com");
  });

  it("caches a negative result in KV too", async () => {
    const env = makeEnv();
    await routerWorker.fetch(healthReq("https://ghost.naelao.com"), env as never, execCtx);
    expect(env.__kv.store.get("cors:origin:ghost.naelao.com")).toBe("0");
  });

  it("still honors the static allowlist alongside dynamic resolution", async () => {
    const env = makeEnv();
    const res = await routerWorker.fetch(healthReq("https://dashboard.naelao.com"), env as never, execCtx);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://dashboard.naelao.com");
  });

  it("degrades to static-allowlist-only (never crashes) when PLATFORM_DB isn't wired", async () => {
    const env = makeEnv({ withDb: false });
    const res = await routerWorker.fetch(healthReq("https://acme.naelao.com"), env as never, execCtx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("works without a KV cache too (just skips caching, still resolves dynamically)", async () => {
    const env = makeEnv({ withKv: false });
    await seedProduct(env, "acme");
    const res = await routerWorker.fetch(healthReq("https://acme.naelao.com"), env as never, execCtx);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://acme.naelao.com");
  });
});
