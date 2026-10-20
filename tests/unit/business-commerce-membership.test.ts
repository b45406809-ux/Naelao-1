import { describe, it, expect } from "vitest";
import spacesWorker from "../../workers/spaces/src/index.js";
import { mintInternalToken } from "@naelao/http";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

// §A1.17 Phase N: requireBusinessMembership gates the manifest-driven operator-shell routes
// (products/orders/revenue) exactly like the pricing routes before it — a business owner
// (product_end_user) may view (GET) their own business's commerce data as a "member", but
// mutating the catalog (POST/PATCH/DELETE) needs the "admin" default floor. Every builder role
// is unaffected (loadCommerceContext's own tenant-scoped ownership check, unchanged).

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const PLATFORM_SECRET = "test-platform-secret";

const SPACES_TABLE_SQL = `
  CREATE TABLE spaces (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    name TEXT NOT NULL DEFAULT '', spacetype_id TEXT NOT NULL DEFAULT 'launchpad',
    config_json TEXT NOT NULL DEFAULT '{}', parent_space_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), created_by TEXT
  );
`;
const BUSINESS_MEMBERSHIPS_SQL = `
  CREATE TABLE business_memberships (
    business_space_id TEXT NOT NULL, product_space_id TEXT NOT NULL, end_user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member', status TEXT NOT NULL DEFAULT 'active',
    invited_by TEXT, joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (business_space_id, end_user_id)
  );
`;
const SPACE_MEMBERS_SQL = `
  CREATE TABLE space_members (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL, end_user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member', suspended_at TEXT
  );
`;
const LAUNCHPAD_PRODUCTS_SQL = `
  CREATE TABLE launchpad_products (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '', price_cents INTEGER NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'USD', kind TEXT NOT NULL DEFAULT 'one_time',
    fulfillment_r2_key TEXT, ls_variant_id TEXT, ls_product_id TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;
const LAUNCHPAD_ORDERS_SQL = `
  CREATE TABLE launchpad_orders (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL, tenant_id TEXT NOT NULL, product_id TEXT,
    customer_email TEXT, customer_name TEXT, gross_cents INTEGER NOT NULL DEFAULT 0,
    fee_cents INTEGER NOT NULL DEFAULT 0, net_cents INTEGER NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'USD', ls_order_id TEXT, ls_subscription_id TEXT,
    status TEXT NOT NULL DEFAULT 'paid', provider_event_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

function makeConfigKv() {
  return {
    async get(key: string) {
      if (key === "space-type-manifest:v2:launchpad") {
        return { productConfig: { commerce: { enabled: true, defaultCurrency: "USD" } }, commerce: { enabled: true, defaultCurrency: "USD" } };
      }
      return null;
    },
    async put() {},
  };
}

function makeEnv() {
  const fakeDb = createFakeD1([SPACES_TABLE_SQL, BUSINESS_MEMBERSHIPS_SQL, SPACE_MEMBERS_SQL, LAUNCHPAD_PRODUCTS_SQL, LAUNCHPAD_ORDERS_SQL]);
  fakeDb.db.exec("INSERT INTO spaces (id, tenant_id, status, name) VALUES ('prod-1', 'tenant-1', 'active', 'Product Root')");
  fakeDb.db.exec("INSERT INTO space_members (id, space_id, end_user_id, role) VALUES ('member-1', 'prod-1', 'eu-1', 'member')");
  return {
    PLATFORM_SECRET,
    ENVIRONMENT: "test",
    PLATFORM_DB: fakeDb,
    NAELAO_CONFIG_KV: makeConfigKv(),
  };
}

async function internalHeaders(tenantId: string, extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const token = await mintInternalToken(PLATFORM_SECRET, tenantId);
  return { "content-type": "application/json", "x-naelao-tenant-id": tenantId, "x-naelao-internal-token": token, ...extra };
}

function req(path: string, headers: Record<string, string>, init?: RequestInit): Request {
  return new Request(`https://spaces.naelao.com${path}`, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) } });
}

describe("requireBusinessMembership — products/orders/revenue (Phase N operator shell)", () => {
  it("a product_end_user can list products, view orders, and view revenue (member floor)", async () => {
    const env = makeEnv();
    const headers = await internalHeaders("tenant-1", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "eu-1" });

    const productsRes = await spacesWorker.fetch(req("/spaces/prod-1/products", headers), env as never, execCtx);
    expect(productsRes.status).toBe(200);

    const ordersRes = await spacesWorker.fetch(req("/spaces/prod-1/orders", headers), env as never, execCtx);
    expect(ordersRes.status).toBe(200);

    const revenueRes = await spacesWorker.fetch(req("/spaces/prod-1/revenue", headers), env as never, execCtx);
    expect(revenueRes.status).toBe(200);
  });

  it("a product_end_user can create a product but CANNOT publish/archive it (admin floor)", async () => {
    const env = makeEnv();
    const headers = await internalHeaders("tenant-1", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "eu-1" });

    const createRes = await spacesWorker.fetch(
      req("/spaces/prod-1/products", headers, { method: "POST", body: JSON.stringify({ name: "Course" }) }),
      env as never, execCtx
    );
    expect(createRes.status).toBe(403);
  });

  it("a builder role (owner) is unaffected — can create AND publish", async () => {
    const env = makeEnv();
    const builderHeaders = await internalHeaders("tenant-1", { "x-naelao-role": "owner", "x-naelao-user-id": "builder-1" });

    const createRes = await spacesWorker.fetch(
      req("/spaces/prod-1/products", builderHeaders, { method: "POST", body: JSON.stringify({ name: "Course" }) }),
      env as never, execCtx
    );
    expect(createRes.status).toBe(201);
    const { id } = await createRes.json() as { id: string };

    const patchRes = await spacesWorker.fetch(
      req(`/spaces/prod-1/products/${id}`, builderHeaders, { method: "PATCH", body: JSON.stringify({ status: "published" }) }),
      env as never, execCtx
    );
    expect(patchRes.status).toBe(200);
  });

  it("a product_end_user who is NOT a member of a business space is rejected entirely", async () => {
    const env = makeEnv();
    env.PLATFORM_DB.db.exec(
      "INSERT INTO spaces (id, tenant_id, status, name, parent_space_id) VALUES ('biz-1', 'biz-tenant-1', 'active', 'Biz', 'prod-1')"
    );
    const headers = await internalHeaders("biz-tenant-1", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "not-a-member" });
    const res = await spacesWorker.fetch(req("/spaces/biz-1/products", headers), env as never, execCtx);
    expect(res.status).toBe(403);
  });
});
