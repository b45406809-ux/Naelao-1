import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import spacesWorker from "../../workers/spaces/src/index.js";
import { BuilderAccountDO } from "../../workers/spaces/src/do/BuilderAccountDO.js";
import { ProductUserDO } from "../../workers/spaces/src/do/ProductUserDO.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
import { makeStatefulDoNamespace } from "./helpers/fake-do-namespace.js";
import { mintInternalToken } from "@naelao/http";

// Three-Tier Platform Model, Phase 3 (docs/spec-appendix A1.17): the Builder Dashboard API
// (/builder/products*, /builder/api-keys*, /builder/billing*). Exercises the REAL spaces worker
// through Hono's fetch(), backed by real BuilderAccountDO/ProductUserDO instances (via
// makeStatefulDoNamespace) and a real-SQLite D1 running the actual migrations — no hand-rolled
// SQL mocks, matching this repo's established test convention.

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const SPACES_TABLE_SQL = `
  CREATE TABLE spaces (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', suspension_reason TEXT,
    name TEXT NOT NULL DEFAULT '', spacetype_id TEXT NOT NULL DEFAULT 'launchpad',
    config_json TEXT NOT NULL DEFAULT '{}', parent_space_id TEXT, depth INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), created_by TEXT
  );
  -- createSpaceRecord (create-space.ts) queries these; real schema per 0002_orgs.sql / 0003_spaces.sql.
  CREATE TABLE orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', owner_id TEXT NOT NULL DEFAULT '', plan_tier TEXT NOT NULL DEFAULT 'free', status TEXT NOT NULL DEFAULT 'active', suspension_reason TEXT);
  CREATE TABLE spacetypes (id TEXT PRIMARY KEY, schema_json TEXT);
`;
const NAELAO_PRODUCT_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0044_naelao_product.sql"), "utf8");
const BUILDER_DASHBOARD_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0045_builder_dashboard_api.sql"), "utf8");
const COMMERCE_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0035_commerce.sql"), "utf8");
const LEDGER_KIND_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0061_reseller_ledger_kind.sql"), "utf8");
const RESELLER_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0033_reseller_accounts.sql"), "utf8");
const GDPR_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0025_gdpr_requests.sql"), "utf8");
const ERASURE_OUTBOX_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0118_gdpr_erasure_outbox.sql"), "utf8");

function makeEnv() {
  const fakeDb = createFakeD1([SPACES_TABLE_SQL, GDPR_MIGRATION, ERASURE_OUTBOX_MIGRATION, NAELAO_PRODUCT_MIGRATION, BUILDER_DASHBOARD_MIGRATION, COMMERCE_MIGRATION, RESELLER_MIGRATION, LEDGER_KIND_MIGRATION]);
  const events: unknown[] = [];
  return {
    PLATFORM_SECRET: "s",
    ENVIRONMENT: "test",
    PLATFORM_DB: fakeDb,
    EVENTS_QUEUE: { send: async (message: unknown) => { events.push(message); } },
    _events: events,
    BUILDER_ACCOUNT_DO: makeStatefulDoNamespace(BuilderAccountDO),
    PRODUCT_USER_DO: makeStatefulDoNamespace(ProductUserDO),
    NAELAO_CONFIG_KV: { get: async () => null, put: async () => {} },
  };
}

async function req(path: string, opts: { method?: string; body?: unknown; tenant?: string; bearer?: string; role?: string; userId?: string } = {}): Promise<Request> {
  const headers = new Headers();
  if (opts.tenant) {
    headers.set("x-naelao-tenant-id", opts.tenant);
    headers.set("x-naelao-internal-token", await mintInternalToken("s", opts.tenant));
    if (opts.role) headers.set("x-naelao-role", opts.role);
    if (opts.userId) headers.set("x-naelao-user-id", opts.userId);
  }
  if (opts.bearer) headers.set("authorization", `Bearer ${opts.bearer}`);
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  return new Request(`https://spaces.naelao.com${path}`, {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

describe("Builder Dashboard API — auth resolution", () => {
  it("401s with neither a tenant header nor a bearer key", async () => {
    const env = makeEnv();
    const res = await spacesWorker.fetch(await req("/builder/products"), env as never, execCtx);
    expect(res.status).toBe(401);
  });

  it("rejects a forged tenant header without the router signature", async () => {
    const env = makeEnv();
    const res = await spacesWorker.fetch(new Request("https://spaces.naelao.com/builder/products", {
      headers: { "x-naelao-tenant-id": "tenant-victim" },
    }), env as never, execCtx);
    expect(res.status).toBe(401);
  });

  it("rejects unknown, duplicate, oversized, or invalid-expiry API key configurations", async () => {
    const env = makeEnv();
    for (const body of [
      { name: "K", scopes: ["admin:all"] },
      { name: "K", scopes: ["spaces:read", "spaces:read"] },
      { name: "K", scopes: ["spaces:read"], expires_in_days: 0 },
      { name: "K", scopes: ["spaces:read"], expires_in_days: 3651 },
      { name: "K", scopes: ["spaces:read"], expires_in_days: 1.5 },
      { name: "K".repeat(81), scopes: ["spaces:read"] },
    ]) {
      const response = await spacesWorker.fetch(await req("/builder/api-keys", { method: "POST", tenant: "tenant-1", body }), env as never, execCtx);
      expect(response.status).toBe(400);
    }
  });

  it("session auth (x-naelao-tenant-id) works for the Dashboard's own calls", async () => {
    const env = makeEnv();
    const res = await spacesWorker.fetch(await req("/builder/products", { tenant: "tenant-1" }), env as never, execCtx);
    expect(res.status).toBe(200);
  });

  it("a minted nbk_ key authenticates as its own builder, distinct from other tenants", async () => {
    const env = makeEnv();
    const created = await (await spacesWorker.fetch(
      await req("/builder/api-keys", { method: "POST", tenant: "tenant-1", body: { name: "CI", scopes: ["spaces:read"] } }),
      env as never, execCtx
    )).json() as { key: string };
    expect(created.key).toMatch(/^nbk_/);

    const viaKey = await spacesWorker.fetch(await req("/builder/products", { bearer: created.key }), env as never, execCtx);
    expect(viaKey.status).toBe(200);
  });

  it("enforces API-key scopes and prevents a key from minting broader child scopes", async () => {
    const env = makeEnv();
    const readKey = await (await spacesWorker.fetch(
      await req("/builder/api-keys", { method: "POST", tenant: "tenant-1", body: { name: "Read", scopes: ["spaces:read"] } }),
      env as never, execCtx
    )).json() as { key: string };
    expect((await spacesWorker.fetch(await req("/builder/products", { bearer: readKey.key }), env as never, execCtx)).status).toBe(200);
    expect((await spacesWorker.fetch(await req("/builder/products", { method: "POST", bearer: readKey.key, body: { name: "No", spacetype_id: "launchpad" } }), env as never, execCtx)).status).toBe(403);

    const writeKey = await (await spacesWorker.fetch(
      await req("/builder/api-keys", { method: "POST", tenant: "tenant-1", body: { name: "Write", scopes: ["spaces:write"] } }),
      env as never, execCtx
    )).json() as { key: string };
    const escalation = await spacesWorker.fetch(await req("/builder/api-keys", {
      method: "POST", bearer: writeKey.key, body: { name: "Escalated", scopes: ["billing:read"] },
    }), env as never, execCtx);
    expect(escalation.status).toBe(403);
  });

  it("a forged bearer key is rejected", async () => {
    const env = makeEnv();
    const res = await spacesWorker.fetch(await req("/builder/products", { bearer: "nbk_totallyforged" }), env as never, execCtx);
    expect(res.status).toBe(401);
  });

  it("the raw key is never present in the create response's persisted form (no key_hash leak)", async () => {
    const env = makeEnv();
    const res = await spacesWorker.fetch(
      await req("/builder/api-keys", { method: "POST", tenant: "tenant-1", body: { name: "K", scopes: ["spaces:read"] } }),
      env as never, execCtx
    );
    const body = await res.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty("key_hash");
    expect(body).toHaveProperty("key");
  });

  it("revoking a key makes it stop authenticating", async () => {
    const env = makeEnv();
    const created = await (await spacesWorker.fetch(
      await req("/builder/api-keys", { method: "POST", tenant: "tenant-1", body: { name: "K", scopes: ["spaces:read"] } }),
      env as never, execCtx
    )).json() as { id: string; key: string };
    await spacesWorker.fetch(await req(`/builder/api-keys/${created.id}`, { method: "DELETE", tenant: "tenant-1" }), env as never, execCtx);
    const viaKey = await spacesWorker.fetch(await req("/builder/products", { bearer: created.key }), env as never, execCtx);
    expect(viaKey.status).toBe(401);
  });
});

describe("Builder Dashboard API — /builder/products CRUD", () => {
  it("creates a real, immediately-live product (no separate draft DB status — the wizard collects everything client-side and calls this once at launch), rejects a malformed slug, enforces slug uniqueness", async () => {
    const env = makeEnv();
    const created = await (await spacesWorker.fetch(
      await req("/builder/products", { method: "POST", tenant: "tenant-1", body: { name: "My Shop", spacetype_id: "launchpad", product_slug: "my-shop" } }),
      env as never, execCtx
    )).json() as { id: string; status: string };
    // No PROVISION_QUEUE bound in this test env, so createSpaceRecord's fallback (matching
    // /spaces POST's own local-dev behavior) is immediate 'active', not 'provisioning'.
    expect(created.status).toBe("active");

    const badSlug = await spacesWorker.fetch(
      await req("/builder/products", { method: "POST", tenant: "tenant-1", body: { name: "X", spacetype_id: "launchpad", product_slug: "NOT VALID" } }),
      env as never, execCtx
    );
    expect(badSlug.status).toBe(400);

    const dupeSlug = await spacesWorker.fetch(
      await req("/builder/products", { method: "POST", tenant: "tenant-2", body: { name: "Y", spacetype_id: "launchpad", product_slug: "my-shop" } }),
      env as never, execCtx
    );
    expect(dupeSlug.status).toBe(409);
  });

  it("lists only the calling tenant's products", async () => {
    const env = makeEnv();
    await spacesWorker.fetch(await req("/builder/products", { method: "POST", tenant: "tenant-1", body: { name: "A", spacetype_id: "launchpad" } }), env as never, execCtx);
    await spacesWorker.fetch(await req("/builder/products", { method: "POST", tenant: "tenant-2", body: { name: "B", spacetype_id: "launchpad" } }), env as never, execCtx);
    const list = await (await spacesWorker.fetch(await req("/builder/products", { tenant: "tenant-1" }), env as never, execCtx)).json() as { data: unknown[] };
    expect(list.data).toHaveLength(1);
  });

  it("paginates portfolios beyond the previous 200-product cap with a full total", async () => {
    const env = makeEnv();
    for (let i = 0; i < 205; i++) {
      env.PLATFORM_DB.db.prepare(`INSERT INTO spaces (id, tenant_id, name, spacetype_id)
        VALUES (?, 'tenant-1', ?, 'launchpad')`).run(`product-${String(i).padStart(3, "0")}`, `Product ${i}`);
    }
    const fetchPage = async (page: number) => {
      const response = await spacesWorker.fetch(await req(`/builder/products?page=${page}`, { tenant: "tenant-1" }), env as never, execCtx);
      expect(response.status).toBe(200);
      return response.json() as Promise<{ data: Array<{ id: string }>; product_count: number; page: number; page_size: number; page_count: number }>;
    };

    const first = await fetchPage(1);
    const second = await fetchPage(2);
    expect(first).toMatchObject({ product_count: 205, page: 1, page_size: 200, page_count: 2 });
    expect(first.data).toHaveLength(200);
    expect(second.data).toHaveLength(5);
    expect(new Set([...first.data, ...second.data].map((product) => product.id)).size).toBe(205);

    const fractional = await spacesWorker.fetch(await req("/builder/products?page=1.5", { tenant: "tenant-1" }), env as never, execCtx);
    const outside = await spacesWorker.fetch(await req("/builder/products?page=3", { tenant: "tenant-1" }), env as never, execCtx);
    expect(fractional.status).toBe(400);
    expect(outside.status).toBe(400);
  });

  it("404s fetching another tenant's product — ownership never leaks", async () => {
    const env = makeEnv();
    const created = await (await spacesWorker.fetch(
      await req("/builder/products", { method: "POST", tenant: "tenant-1", body: { name: "A", spacetype_id: "launchpad" } }), env as never, execCtx
    )).json() as { id: string };
    const res = await spacesWorker.fetch(await req(`/builder/products/${created.id}`, { tenant: "tenant-2" }), env as never, execCtx);
    expect(res.status).toBe(404);
  });

  it("PATCH rejects an unknown status but accepts an allowed one, and merges product_config", async () => {
    const env = makeEnv();
    const created = await (await spacesWorker.fetch(
      await req("/builder/products", { method: "POST", tenant: "tenant-1", body: { name: "A", spacetype_id: "launchpad" } }), env as never, execCtx
    )).json() as { id: string };

    const badStatus = await spacesWorker.fetch(
      await req(`/builder/products/${created.id}`, { method: "PATCH", tenant: "tenant-1", body: { status: "not_a_real_status" } }), env as never, execCtx
    );
    expect(badStatus.status).toBe(400);

    const ok = await spacesWorker.fetch(
      await req(`/builder/products/${created.id}`, { method: "PATCH", tenant: "tenant-1", body: { status: "active", product_config: { branding: { brandColor: "#111" } } } }),
      env as never, execCtx
    );
    expect(ok.status).toBe(200);

    const fetched = await (await spacesWorker.fetch(await req(`/builder/products/${created.id}`, { tenant: "tenant-1" }), env as never, execCtx)).json() as { status: string; product_config: { branding?: { brandColor?: string } } };
    expect(fetched.status).toBe("active");
    expect(fetched.product_config.branding?.brandColor).toBe("#111");
  });

  it("prevents product owners from releasing admin suspension through either status API", async () => {
    const env = makeEnv();
    const created = await (await spacesWorker.fetch(
      await req("/builder/products", { method: "POST", tenant: "tenant-1", body: { name: "A", spacetype_id: "launchpad" } }), env as never, execCtx
    )).json() as { id: string };
    env.PLATFORM_DB.prepare("UPDATE spaces SET status = 'suspended', suspension_reason = 'admin_product' WHERE id = ?")
      .bind(created.id).run();

    const builderRestore = await spacesWorker.fetch(
      await req(`/builder/products/${created.id}`, { method: "PATCH", tenant: "tenant-1", body: { status: "active" } }), env as never, execCtx
    );
    expect(builderRestore.status).toBe(409);

    const legacyRestore = await spacesWorker.fetch(
      await req(`/spaces/${created.id}`, { method: "PATCH", tenant: "tenant-1", role: "owner", body: { status: "active" } }), env as never, execCtx
    );
    expect(legacyRestore.status).toBe(409);
    await expect(env.PLATFORM_DB.prepare("SELECT status, suspension_reason FROM spaces WHERE id = ?").bind(created.id).first())
      .resolves.toEqual({ status: "suspended", suspension_reason: "admin_product" });

    env.PLATFORM_DB.prepare("UPDATE spaces SET suspension_reason = NULL WHERE id = ?").bind(created.id).run();
    expect((await spacesWorker.fetch(
      await req(`/builder/products/${created.id}`, { method: "PATCH", tenant: "tenant-1", body: { status: "active" } }), env as never, execCtx
    )).status).toBe(409);
    expect((await spacesWorker.fetch(
      await req(`/spaces/${created.id}`, { method: "PATCH", tenant: "tenant-1", role: "owner", body: { status: "active" } }), env as never, execCtx
    )).status).toBe(409);
  });

  it("applies role permissions to the legacy space update and delete APIs", async () => {
    const env = makeEnv();
    const created = await (await spacesWorker.fetch(
      await req("/builder/products", { method: "POST", tenant: "tenant-1", body: { name: "A", spacetype_id: "launchpad" } }), env as never, execCtx
    )).json() as { id: string };

    const viewerPatch = await spacesWorker.fetch(
      await req(`/spaces/${created.id}`, { method: "PATCH", tenant: "tenant-1", role: "viewer", body: { name: "Changed" } }), env as never, execCtx
    );
    expect(viewerPatch.status).toBe(403);
    const viewerDelete = await spacesWorker.fetch(
      await req(`/spaces/${created.id}`, { method: "DELETE", tenant: "tenant-1", role: "viewer" }), env as never, execCtx
    );
    expect(viewerDelete.status).toBe(403);
    const editorStatus = await spacesWorker.fetch(
      await req(`/spaces/${created.id}`, { method: "PATCH", tenant: "tenant-1", role: "editor", body: { status: "paused" } }), env as never, execCtx
    );
    expect(editorStatus.status).toBe(403);
    const editorName = await spacesWorker.fetch(
      await req(`/spaces/${created.id}`, { method: "PATCH", tenant: "tenant-1", role: "editor", body: { name: "Changed" } }), env as never, execCtx
    );
    expect(editorName.status).toBe(200);
    await expect(env.PLATFORM_DB.prepare("SELECT name FROM spaces WHERE id = ?").bind(created.id).first())
      .resolves.toEqual({ name: "Changed" });
  });

  it("requires a space writer role to create a space through the legacy endpoint", async () => {
    const env = makeEnv();
    const viewer = await spacesWorker.fetch(
      await req("/spaces", { method: "POST", tenant: "tenant-1", role: "viewer", body: { name: "Viewer Space", spacetype_id: "launchpad" } }), env as never, execCtx
    );
    expect(viewer.status).toBe(403);
    const editor = await spacesWorker.fetch(
      await req("/spaces", { method: "POST", tenant: "tenant-1", role: "editor", body: { name: "Editor Space", spacetype_id: "launchpad" } }), env as never, execCtx
    );
    expect(editor.status).toBe(201);
  });

  it("DELETE soft-deletes — the product then 404s", async () => {
    const env = makeEnv();
    const created = await (await spacesWorker.fetch(
      await req("/builder/products", { method: "POST", tenant: "tenant-1", body: { name: "A", spacetype_id: "launchpad" } }), env as never, execCtx
    )).json() as { id: string };
    const del = await spacesWorker.fetch(await req(`/builder/products/${created.id}`, { method: "DELETE", tenant: "tenant-1" }), env as never, execCtx);
    expect(del.status).toBe(204);
    const after = await spacesWorker.fetch(await req(`/builder/products/${created.id}`, { tenant: "tenant-1" }), env as never, execCtx);
    expect(after.status).toBe(404);
  });

  it("frees the deleted product's address so the name can be used again", async () => {
    // The unique index on product_slug doesn't exclude deleted rows, so a soft delete used to
    // burn the name permanently: a builder who deleted a product and rebuilt it under the same
    // name got a replacement with NO slug — and therefore no working URL at all, since nothing
    // lets a slug be set after creation.
    const env = makeEnv();
    const first = await (await spacesWorker.fetch(
      await req("/builder/products", { method: "POST", tenant: "tenant-1", body: { name: "Launchpad", spacetype_id: "launchpad" } }), env as never, execCtx
    )).json() as { id: string };
    await spacesWorker.fetch(await req(`/builder/products/${first.id}`, { method: "DELETE", tenant: "tenant-1" }), env as never, execCtx);

    const second = await (await spacesWorker.fetch(
      await req("/builder/products", { method: "POST", tenant: "tenant-1", body: { name: "Launchpad", spacetype_id: "launchpad" } }), env as never, execCtx
    )).json() as { id: string };
    const row = await env.PLATFORM_DB.prepare("SELECT product_slug FROM spaces WHERE id = ?")
      .bind(second.id).first<{ product_slug: string | null }>();
    expect(row?.product_slug).toBe("launchpad");
  });
});

describe("POST /spaces request boundaries", () => {
  it("rejects malformed and oversized space-creation bodies before inserting a row", async () => {
    const env = makeEnv();
    const malformed = await spacesWorker.fetch(new Request("https://spaces.naelao.com/spaces", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": "tenant-1",
        "x-naelao-user-id": "owner-1",
        "x-naelao-role": "owner",
        "x-naelao-internal-token": await mintInternalToken("s", "tenant-1"),
      },
      body: "{",
    }), env as never, execCtx);
    const oversized = await spacesWorker.fetch(await req("/spaces", {
      method: "POST", tenant: "tenant-1", role: "owner", body: "x".repeat(64 * 1024 + 1),
    }), env as never, execCtx);

    expect(malformed.status).toBe(400);
    expect(oversized.status).toBe(413);
    const count = await env.PLATFORM_DB.prepare("SELECT COUNT(*) AS count FROM spaces").first<{ count: number }>();
    expect(count?.count).toBe(0);
  });
});

describe("Builder Dashboard API — domain (dev path, no CF secrets configured)", () => {
  it("records pending_dns intent without a live CF-for-SaaS call", async () => {
    const env = makeEnv();
    const created = await (await spacesWorker.fetch(
      await req("/builder/products", { method: "POST", tenant: "tenant-1", body: { name: "A", spacetype_id: "launchpad" } }), env as never, execCtx
    )).json() as { id: string };
    const domainRes = await spacesWorker.fetch(
      await req(`/builder/products/${created.id}/domain`, { method: "POST", tenant: "tenant-1", body: { custom_domain: "shop.example.com" } }), env as never, execCtx
    );
    expect(domainRes.status).toBe(202);
    const domainBody = await domainRes.json() as { status: string };
    expect(domainBody.status).toBe("pending_dns");

    const getRes = await (await spacesWorker.fetch(await req(`/builder/products/${created.id}/domain`, { tenant: "tenant-1" }), env as never, execCtx)).json() as { custom_domain: string };
    expect(getRes.custom_domain).toBe("shop.example.com");
  });
});

describe("Builder Dashboard API — users roster", () => {
  it("suspend revokes ProductUserDO sessions and marks the roster row", async () => {
    const env = makeEnv();
    const created = await (await spacesWorker.fetch(
      await req("/builder/products", { method: "POST", tenant: "tenant-1", body: { name: "A", spacetype_id: "launchpad" } }), env as never, execCtx
    )).json() as { id: string };
    await env.PLATFORM_DB.prepare(
      "INSERT INTO product_end_users (product_space_id, end_user_id) VALUES (?, ?)"
    ).bind(created.id, "user-1").run();

    const suspendRes = await spacesWorker.fetch(await req(`/builder/products/${created.id}/users/user-1/suspend`, { method: "POST", tenant: "tenant-1" }), env as never, execCtx);
    expect(suspendRes.status).toBe(200);
    const roster = await (await spacesWorker.fetch(await req(`/builder/products/${created.id}/users`, { tenant: "tenant-1" }), env as never, execCtx)).json() as { data: Array<{ suspended_at: string | null }> };
    expect(roster.data[0]!.suspended_at).not.toBeNull();
  });

  it("404s for a product owned by a different tenant", async () => {
    const env = makeEnv();
    const created = await (await spacesWorker.fetch(
      await req("/builder/products", { method: "POST", tenant: "tenant-1", body: { name: "A", spacetype_id: "launchpad" } }), env as never, execCtx
    )).json() as { id: string };
    const res = await spacesWorker.fetch(await req(`/builder/products/${created.id}/users`, { tenant: "tenant-2" }), env as never, execCtx);
    expect(res.status).toBe(404);
  });
});

describe("Builder Dashboard API — analytics", () => {
  it("dau/mau/total_users reflect product_end_users.last_seen_at; credits_consumed is honestly null", async () => {
    const env = makeEnv();
    const created = await (await spacesWorker.fetch(
      await req("/builder/products", { method: "POST", tenant: "tenant-1", body: { name: "A", spacetype_id: "launchpad" } }), env as never, execCtx
    )).json() as { id: string };
    const now = new Date().toISOString();
    const longAgo = new Date(Date.now() - 90 * 86_400_000).toISOString();
    await env.PLATFORM_DB.prepare("INSERT INTO product_end_users (product_space_id, end_user_id, last_seen_at) VALUES (?, ?, ?)").bind(created.id, "u1", now).run();
    await env.PLATFORM_DB.prepare("INSERT INTO product_end_users (product_space_id, end_user_id, last_seen_at) VALUES (?, ?, ?)").bind(created.id, "u2", longAgo).run();

    const analytics = await (await spacesWorker.fetch(await req(`/builder/products/${created.id}/analytics`, { tenant: "tenant-1" }), env as never, execCtx)).json() as { dau: number; mau: number; total_users: number; credits_consumed: null };
    expect(analytics.dau).toBe(1);
    expect(analytics.mau).toBe(1);
    expect(analytics.total_users).toBe(2);
    expect(analytics.credits_consumed).toBeNull();
  });

  it("revenue rolls up launchpad_orders (gross/fee/net) and reseller_ledger (wholesale cost)", async () => {
    const env = makeEnv();
    const created = await (await spacesWorker.fetch(
      await req("/builder/products", { method: "POST", tenant: "tenant-1", body: { name: "A", spacetype_id: "launchpad" } }), env as never, execCtx
    )).json() as { id: string };
    const period = new Date().toISOString().slice(0, 7);
    await env.PLATFORM_DB.prepare(
      "INSERT INTO launchpad_orders (id, space_id, tenant_id, gross_cents, fee_cents, net_cents, status) VALUES ('o1', ?, 'tenant-1', 10000, 500, 9500, 'paid')"
    ).bind(created.id).run();
    await env.PLATFORM_DB.prepare(
      `INSERT INTO reseller_ledger (id, parent_tenant_id, child_tenant_id, child_space_id, event_type, period, currency, retail_cents, wholesale_cents, margin_cents)
       VALUES ('l1', 'tenant-1', 'tenant-1-child', 'child-space-1', 'order', ?, 'USD', 10000, 8000, 2000)`
    ).bind(period).run();

    const revenue = await (await spacesWorker.fetch(await req(`/builder/products/${created.id}/analytics/revenue`, { tenant: "tenant-1" }), env as never, execCtx)).json() as {
      gross_revenue_cents: number; naelao_fee_cents: number; net_revenue_cents: number; naelao_wholesale_cost_cents: number;
    };
    expect(revenue.gross_revenue_cents).toBe(10000);
    expect(revenue.naelao_fee_cents).toBe(500);
    expect(revenue.net_revenue_cents).toBe(9500);
    expect(revenue.naelao_wholesale_cost_cents).toBe(8000);
  });

  it("/builder/billing statement counts ONLY kind='attribution', not builder_revenue_share (audit)", async () => {
    const env = makeEnv();
    const period = new Date().toISOString().slice(0, 7);
    // A wholesale attribution row (the reseller relationship) …
    await env.PLATFORM_DB.prepare(
      `INSERT INTO reseller_ledger (id, parent_tenant_id, child_tenant_id, child_space_id, event_type, period, currency, retail_cents, wholesale_cents, margin_cents, kind)
       VALUES ('attr1', 'tenant-1', 'child-t', 'child-s', 'payment.success', ?, 'USD', 10000, 8000, 2000, 'attribution')`
    ).bind(period).run();
    // … and a builder_revenue_share row (a different stream — must NOT pollute the wholesale statement).
    await env.PLATFORM_DB.prepare(
      `INSERT INTO reseller_ledger (id, parent_tenant_id, child_tenant_id, child_space_id, event_type, period, currency, retail_cents, wholesale_cents, margin_cents, kind)
       VALUES ('brs1', 'tenant-1', 'child-t', 'child-s', 'payment.success', ?, 'USD', 50000, 0, 5000, 'builder_revenue_share')`
    ).bind(period).run();

    const billing = await (await spacesWorker.fetch(await req(`/builder/billing?period=${period}`, { tenant: "tenant-1" }), env as never, execCtx)).json() as {
      retail: number; wholesale: number; margin: number; events: number;
    };
    // Only the attribution row is counted — the builder_revenue_share row is excluded entirely.
    expect(billing.retail).toBe(10000);
    expect(billing.margin).toBe(2000);
    expect(billing.events).toBe(1);
  });
});

describe("Builder Dashboard API — feature flags and webhooks", () => {
  it("PUT feature-flags persists into config_json.productConfig.featureFlags", async () => {
    const env = makeEnv();
    const created = await (await spacesWorker.fetch(
      await req("/builder/products", { method: "POST", tenant: "tenant-1", body: { name: "A", spacetype_id: "launchpad" } }), env as never, execCtx
    )).json() as { id: string };
    await spacesWorker.fetch(
      await req(`/builder/products/${created.id}/feature-flags`, { method: "PUT", tenant: "tenant-1", body: { flags: { betaWidget: true } } }), env as never, execCtx
    );
    const fetched = await (await spacesWorker.fetch(await req(`/builder/products/${created.id}`, { tenant: "tenant-1" }), env as never, execCtx)).json() as { product_config: { featureFlags?: Record<string, boolean> } };
    expect(fetched.product_config.featureFlags?.betaWidget).toBe(true);
  });

  it("registers and lists webhooks", async () => {
    const env = makeEnv();
    const created = await (await spacesWorker.fetch(
      await req("/builder/products", { method: "POST", tenant: "tenant-1", body: { name: "A", spacetype_id: "launchpad" } }), env as never, execCtx
    )).json() as { id: string };
    await spacesWorker.fetch(
      await req(`/builder/products/${created.id}/webhooks`, { method: "POST", tenant: "tenant-1", body: { url: "https://example.com/hook", event_types: ["order.completed"] } }), env as never, execCtx
    );
    const list = await (await spacesWorker.fetch(await req(`/builder/products/${created.id}/webhooks`, { tenant: "tenant-1" }), env as never, execCtx)).json() as { data: Array<{ url: string; event_types: string[] }> };
    expect(list.data).toHaveLength(1);
    expect(list.data[0]!.url).toBe("https://example.com/hook");
    expect(list.data[0]!.event_types).toEqual(["order.completed"]);
  });
});

// WS-3: reseller rate config was declared (billingRelationship) but had NO write path anywhere —
// business-create.ts hardcoded wholesale_cents=NULL/referral_share_pct=0.0 literals and its own
// ON CONFLICT upsert never refreshed them. This PATCH is the missing write path, and it updates
// the LIVE reseller_accounts row directly (not just config_json) so an existing tenant's rate
// takes effect immediately.
describe("Builder Dashboard API — PATCH /builder/products/:id/reseller (WS-3)", () => {
  it("sets reseller mode + wholesale rate, persisted in config_json and the live reseller_accounts row", async () => {
    const env = makeEnv();
    const created = await (await spacesWorker.fetch(
      await req("/builder/products", { method: "POST", tenant: "tenant-1", body: { name: "A", spacetype_id: "launchpad" } }), env as never, execCtx
    )).json() as { id: string };

    const patchRes = await spacesWorker.fetch(
      await req(`/builder/products/${created.id}/reseller`, {
        method: "PATCH",
        tenant: "tenant-1",
        body: { billing_relationship: "reseller", wholesale_cents: 2000 },
      }),
      env as never, execCtx
    );
    expect(patchRes.status).toBe(200);
    const body = await patchRes.json() as { billing_relationship: string; reseller_rates: { wholesale_cents: number | null; referral_share_pct: number } };
    expect(body.billing_relationship).toBe("reseller");
    expect(body.reseller_rates.wholesale_cents).toBe(2000);

    // The actual money-path gate (recordResellerAttribution) reads reseller_accounts directly —
    // prove the row was actually written, not just the config_json display copy.
    const row = await env.PLATFORM_DB.prepare(
      "SELECT billing_relationship, wholesale_cents, referral_share_pct FROM reseller_accounts WHERE tenant_id = ?"
    ).bind("tenant-1").first<{ billing_relationship: string; wholesale_cents: number; referral_share_pct: number }>();
    expect(row).toMatchObject({ billing_relationship: "reseller", wholesale_cents: 2000 });
  });

  it("sets referral mode + share pct", async () => {
    const env = makeEnv();
    const created = await (await spacesWorker.fetch(
      await req("/builder/products", { method: "POST", tenant: "tenant-1", body: { name: "A", spacetype_id: "launchpad" } }), env as never, execCtx
    )).json() as { id: string };

    await spacesWorker.fetch(
      await req(`/builder/products/${created.id}/reseller`, {
        method: "PATCH", tenant: "tenant-1", body: { billing_relationship: "referral", referral_share_pct: 25 },
      }),
      env as never, execCtx
    );
    const row = await env.PLATFORM_DB.prepare(
      "SELECT billing_relationship, referral_share_pct FROM reseller_accounts WHERE tenant_id = ?"
    ).bind("tenant-1").first<{ billing_relationship: string; referral_share_pct: number }>();
    expect(row).toMatchObject({ billing_relationship: "referral", referral_share_pct: 25 });
  });

  it("REFRESHES an existing reseller_accounts row's rate — the exact gap business-create.ts's own upsert left open", async () => {
    const env = makeEnv();
    const created = await (await spacesWorker.fetch(
      await req("/builder/products", { method: "POST", tenant: "tenant-1", body: { name: "A", spacetype_id: "launchpad" } }), env as never, execCtx
    )).json() as { id: string };
    // Simulate a pre-existing row from an earlier business-create (the old hardcoded literals).
    await env.PLATFORM_DB.prepare(
      "INSERT INTO reseller_accounts (tenant_id, product_space_id, billing_relationship, wholesale_cents, referral_share_pct) VALUES (?, ?, 'platform', NULL, 0.0)"
    ).bind("tenant-1", created.id).run();

    await spacesWorker.fetch(
      await req(`/builder/products/${created.id}/reseller`, {
        method: "PATCH", tenant: "tenant-1", body: { billing_relationship: "reseller", wholesale_cents: 1500 },
      }),
      env as never, execCtx
    );
    const row = await env.PLATFORM_DB.prepare(
      "SELECT billing_relationship, wholesale_cents FROM reseller_accounts WHERE tenant_id = ?"
    ).bind("tenant-1").first<{ billing_relationship: string; wholesale_cents: number }>();
    expect(row).toMatchObject({ billing_relationship: "reseller", wholesale_cents: 1500 });
  });

  it("rejects an invalid billing_relationship", async () => {
    const env = makeEnv();
    const created = await (await spacesWorker.fetch(
      await req("/builder/products", { method: "POST", tenant: "tenant-1", body: { name: "A", spacetype_id: "launchpad" } }), env as never, execCtx
    )).json() as { id: string };
    const res = await spacesWorker.fetch(
      await req(`/builder/products/${created.id}/reseller`, { method: "PATCH", tenant: "tenant-1", body: { billing_relationship: "bogus" } }),
      env as never, execCtx
    );
    expect(res.status).toBe(400);
  });

  it("rejects an out-of-range referral_share_pct", async () => {
    const env = makeEnv();
    const created = await (await spacesWorker.fetch(
      await req("/builder/products", { method: "POST", tenant: "tenant-1", body: { name: "A", spacetype_id: "launchpad" } }), env as never, execCtx
    )).json() as { id: string };
    const res = await spacesWorker.fetch(
      await req(`/builder/products/${created.id}/reseller`, { method: "PATCH", tenant: "tenant-1", body: { referral_share_pct: 150 } }),
      env as never, execCtx
    );
    expect(res.status).toBe(400);
  });

  it("404s for a product owned by a different tenant", async () => {
    const env = makeEnv();
    const created = await (await spacesWorker.fetch(
      await req("/builder/products", { method: "POST", tenant: "tenant-1", body: { name: "A", spacetype_id: "launchpad" } }), env as never, execCtx
    )).json() as { id: string };
    const res = await spacesWorker.fetch(
      await req(`/builder/products/${created.id}/reseller`, { method: "PATCH", tenant: "tenant-2", body: { billing_relationship: "reseller" } }),
      env as never, execCtx
    );
    expect(res.status).toBe(404);
  });
});

describe("Organization erasure lifecycle API", () => {
  it("lets the verified organization owner request, inspect, and cancel without any active spaces", async () => {
    const env = makeEnv();
    await env.PLATFORM_DB.prepare("INSERT INTO orgs (id, name, owner_id) VALUES (?, ?, ?)")
      .bind("tenant-erase", "Acme", "owner-1").run();

    const created = await spacesWorker.fetch(
      await req("/builder/erasure", { method: "POST", tenant: "tenant-erase", userId: "owner-1", body: { reason: "Close the account" } }),
      env as never, execCtx,
    );
    expect(created.status).toBe(202);
    const request = await created.json() as { request_id: string; status: string; cooling_off_hours: number };
    expect(request).toMatchObject({ status: "pending", cooling_off_hours: 24 });
    expect(env._events).toEqual([{
      type: "data.erasure", orgId: "tenant-erase", requestedBy: "owner-1", reason: "Close the account", requestId: request.request_id,
    }]);

    const duplicate = await spacesWorker.fetch(
      await req("/builder/erasure", { method: "POST", tenant: "tenant-erase", userId: "owner-1", body: {} }),
      env as never, execCtx,
    );
    expect(duplicate.status).toBe(409);
    const nonOwner = await spacesWorker.fetch(
      await req(`/builder/erasure/${request.request_id}`, { tenant: "tenant-erase", userId: "other-user" }),
      env as never, execCtx,
    );
    expect(nonOwner.status).toBe(403);

    await env.PLATFORM_DB.prepare("UPDATE orgs SET status = 'suspended', suspension_reason = 'erasure' WHERE id = ?")
      .bind("tenant-erase").run();
    await env.PLATFORM_DB.prepare("INSERT INTO spaces (id, tenant_id, status, suspension_reason) VALUES (?, ?, ?, ?)")
      .bind("space-erase", "tenant-erase", "suspended", "erasure").run();
    const cancelled = await spacesWorker.fetch(
      await req(`/builder/erasure/${request.request_id}`, { method: "DELETE", tenant: "tenant-erase", userId: "owner-1" }),
      env as never, execCtx,
    );
    expect(cancelled.status).toBe(200);
    expect(await env.PLATFORM_DB.prepare("SELECT status, suspension_reason FROM orgs WHERE id = ?").bind("tenant-erase").first())
      .toEqual({ status: "active", suspension_reason: null });
    expect(await env.PLATFORM_DB.prepare("SELECT status, suspension_reason FROM spaces WHERE id = ?").bind("space-erase").first())
      .toEqual({ status: "active", suspension_reason: null });
    const status = await spacesWorker.fetch(
      await req(`/builder/erasure/${request.request_id}`, { tenant: "tenant-erase", userId: "owner-1" }),
      env as never, execCtx,
    );
    expect(await status.json()).toMatchObject({ request_id: request.request_id, status: "cancelled" });
  });
});

describe("Builder Dashboard API — billing", () => {
  it("rolls up the builder's own wholesale statement for the current period, and history across periods", async () => {
    const env = makeEnv();
    const period = new Date().toISOString().slice(0, 7);
    await env.PLATFORM_DB.prepare(
      `INSERT INTO reseller_ledger (id, parent_tenant_id, child_tenant_id, child_space_id, event_type, period, currency, retail_cents, wholesale_cents, margin_cents)
       VALUES ('l1', 'tenant-1', 'child-1', 'child-space-1', 'order', ?, 'USD', 5000, 4000, 1000)`
    ).bind(period).run();
    await env.PLATFORM_DB.prepare(
      `INSERT INTO reseller_ledger (id, parent_tenant_id, child_tenant_id, child_space_id, event_type, period, currency, retail_cents, wholesale_cents, margin_cents)
       VALUES ('l2', 'tenant-1', 'child-1', 'child-space-1', 'order', '2020-01', 'USD', 100, 80, 20)`
    ).bind().run();

    const billing = await (await spacesWorker.fetch(await req("/builder/billing", { tenant: "tenant-1" }), env as never, execCtx)).json() as { wholesale: number; retail: number };
    expect(billing.wholesale).toBe(4000);
    expect(billing.retail).toBe(5000);

    const history = await (await spacesWorker.fetch(await req("/builder/billing/history", { tenant: "tenant-1" }), env as never, execCtx)).json() as { data: unknown[] };
    expect(history.data).toHaveLength(2);
  });
});
