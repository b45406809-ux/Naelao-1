import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import spacesWorker from "../../workers/spaces/src/index.js";
import { BuilderAccountDO } from "../../workers/spaces/src/do/BuilderAccountDO.js";
import { ProductUserDO } from "../../workers/spaces/src/do/ProductUserDO.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
import { makeStatefulDoNamespace } from "./helpers/fake-do-namespace.js";
import { mintInternalToken } from "@naelao/http";

// Three-Tier Platform Model, Phase 3 — the single highest-liability endpoint in the plan:
// GET /builder/products/:id/users/:userId/conversations. Three INDEPENDENT gates, ALL required:
//   1. feature_flag   — the builder has conversationLogAccess enabled for this product
//   2. staff_approval — a Naelao platform admin has manually approved THIS SPACE
//                        (conversation_access_approved_by/_at, migration 0044 — legally required,
//                        never a builder-settable value)
//   3. user_consent   — the END USER has logged consent (product_end_users.consented_at)
// On success: METADATA ONLY (never message content — sourced from ProductUserDO's
// conversation_refs, which itself never stores message bodies) + an immutable audit row. A denied
// attempt writes NOTHING — nothing was disclosed, so there's nothing to audit.
// This file gets its own dedicated, focused test suite per the plan's explicit call for a
// security-review-grade test pass on this endpoint, separate from the broader Builder Dashboard
// API suite in builder-dashboard-api.test.ts.

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const SPACES_TABLE_SQL = `
  CREATE TABLE spaces (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    name TEXT NOT NULL DEFAULT '', spacetype_id TEXT NOT NULL DEFAULT 'launchpad',
    config_json TEXT NOT NULL DEFAULT '{}', parent_space_id TEXT, depth INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), created_by TEXT
  );
  -- createSpaceRecord (create-space.ts) queries these; real schema per 0002_orgs.sql / 0003_spaces.sql.
  CREATE TABLE orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', owner_id TEXT NOT NULL DEFAULT '', plan_tier TEXT NOT NULL DEFAULT 'free');
  CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);
  CREATE TABLE spacetypes (id TEXT PRIMARY KEY, schema_json TEXT);
`;
const SPACE_SUSPENSION_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0116_space_suspension_reason.sql"), "utf8");
const NAELAO_PRODUCT_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0044_naelao_product.sql"), "utf8");
const BUILDER_DASHBOARD_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0045_builder_dashboard_api.sql"), "utf8");

function makeEnv() {
  const fakeDb = createFakeD1([SPACES_TABLE_SQL, SPACE_SUSPENSION_MIGRATION, NAELAO_PRODUCT_MIGRATION, BUILDER_DASHBOARD_MIGRATION]);
  return {
    PLATFORM_SECRET: "s",
    ENVIRONMENT: "test",
    PLATFORM_DB: fakeDb,
    BUILDER_ACCOUNT_DO: makeStatefulDoNamespace(BuilderAccountDO),
    PRODUCT_USER_DO: makeStatefulDoNamespace(ProductUserDO),
    NAELAO_CONFIG_KV: { get: async () => null, put: async () => {} },
  };
}

async function req(path: string, opts: { method?: string; body?: unknown; tenant?: string } = {}): Promise<Request> {
  const headers = new Headers();
  if (opts.tenant) {
    headers.set("x-naelao-tenant-id", opts.tenant);
    headers.set("x-naelao-internal-token", await mintInternalToken("s", opts.tenant));
  }
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  return new Request(`https://spaces.naelao.com${path}`, {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

type Env = ReturnType<typeof makeEnv>;

/** Create a product owned by `tenant`, optionally toggling each gate independently. */
async function seedProduct(
  env: Env,
  tenant: string,
  opts: { featureFlagOn?: boolean; staffApproved?: boolean; userConsented?: boolean } = {}
): Promise<{ productId: string; userId: string }> {
  const created = await (await spacesWorker.fetch(
    await req("/builder/products", { method: "POST", tenant, body: { name: "A", spacetype_id: "launchpad" } }),
    env as never, execCtx
  )).json() as { id: string };

  if (opts.featureFlagOn) {
    await spacesWorker.fetch(
      await req(`/builder/products/${created.id}`, {
        method: "PATCH", tenant,
        body: { product_config: { adminFeatures: { conversationLogAccess: true } } },
      }), env as never, execCtx
    );
  }
  if (opts.staffApproved) {
    await env.PLATFORM_DB.prepare(
      "UPDATE spaces SET conversation_access_approved_by = ?, conversation_access_approved_at = ? WHERE id = ?"
    ).bind("naelao-staff-1", new Date().toISOString(), created.id).run();
  }
  const userId = "user-1";
  await env.PLATFORM_DB.prepare(
    "INSERT INTO product_end_users (product_space_id, end_user_id, consented_at) VALUES (?, ?, ?)"
  ).bind(created.id, userId, opts.userConsented ? new Date().toISOString() : null).run();

  return { productId: created.id, userId };
}

describe("conversation-access gate — each leg fails independently", () => {
  it("denies when the feature flag is off, even with staff approval + user consent", async () => {
    const env = makeEnv();
    const { productId, userId } = await seedProduct(env, "tenant-1", { featureFlagOn: false, staffApproved: true, userConsented: true });
    const res = await spacesWorker.fetch(await req(`/builder/products/${productId}/users/${userId}/conversations`, { tenant: "tenant-1" }), env as never, execCtx);
    expect(res.status).toBe(403);
    const body = await res.json() as { gate: string };
    expect(body.gate).toBe("feature_flag");
  });

  it("denies when staff has not approved the space, even with the flag on + user consent", async () => {
    const env = makeEnv();
    const { productId, userId } = await seedProduct(env, "tenant-1", { featureFlagOn: true, staffApproved: false, userConsented: true });
    const res = await spacesWorker.fetch(await req(`/builder/products/${productId}/users/${userId}/conversations`, { tenant: "tenant-1" }), env as never, execCtx);
    expect(res.status).toBe(403);
    const body = await res.json() as { gate: string };
    expect(body.gate).toBe("staff_approval");
  });

  it("denies when the end user has not consented, even with flag on + staff approved", async () => {
    const env = makeEnv();
    const { productId, userId } = await seedProduct(env, "tenant-1", { featureFlagOn: true, staffApproved: true, userConsented: false });
    const res = await spacesWorker.fetch(await req(`/builder/products/${productId}/users/${userId}/conversations`, { tenant: "tenant-1" }), env as never, execCtx);
    expect(res.status).toBe(403);
    const body = await res.json() as { gate: string };
    expect(body.gate).toBe("user_consent");
  });

  it("denies when NOTHING is set (the default-closed baseline)", async () => {
    const env = makeEnv();
    const { productId, userId } = await seedProduct(env, "tenant-1", {});
    const res = await spacesWorker.fetch(await req(`/builder/products/${productId}/users/${userId}/conversations`, { tenant: "tenant-1" }), env as never, execCtx);
    expect(res.status).toBe(403);
  });
});

describe("conversation-access gate — all three legs pass", () => {
  it("returns metadata-only conversation refs and never message content", async () => {
    const env = makeEnv();
    const { productId, userId } = await seedProduct(env, "tenant-1", { featureFlagOn: true, staffApproved: true, userConsented: true });

    // Seed a conversation ref directly on the end user's ProductUserDO (metadata only, exactly
    // what a real end-user chat session would write via /conversation-refs).
    const doNs = env.PRODUCT_USER_DO as ReturnType<typeof makeStatefulDoNamespace>;
    const { getDOName } = await import("@naelao/crypto");
    const doName = await getDOName("produser", `${productId}:${userId}`, "tenant-1", "s");
    const stub = doNs.get(doNs.idFromName(doName));
    await stub.fetch(new Request("http://do/conversation-refs", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ thread_id: "t1", space_id: productId, title: "Order question — SUPER SECRET MESSAGE CONTENT SHOULD NOT APPEAR" }),
    }));

    const res = await spacesWorker.fetch(await req(`/builder/products/${productId}/users/${userId}/conversations`, { tenant: "tenant-1" }), env as never, execCtx);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ thread_id: string; title: string }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.thread_id).toBe("t1");
    // The "title" field IS metadata (a thread label, not message content) — confirm the response
    // shape only ever carries what ProductUserDO's conversation_refs exposes (thread_id/space_id/
    // session_id/title/created_at), never a messages/content field.
    expect(body.data[0]).not.toHaveProperty("messages");
    expect(body.data[0]).not.toHaveProperty("content");
  });

  it("writes exactly one immutable audit row per successful disclosure, attributing the accessing builder", async () => {
    const env = makeEnv();
    const { productId, userId } = await seedProduct(env, "tenant-1", { featureFlagOn: true, staffApproved: true, userConsented: true });

    await spacesWorker.fetch(await req(`/builder/products/${productId}/users/${userId}/conversations?purpose=support_ticket_42`, { tenant: "tenant-1" }), env as never, execCtx);

    const rows = await env.PLATFORM_DB.prepare(
      "SELECT product_space_id, end_user_id, accessed_by, purpose FROM conversation_access_audit WHERE product_space_id = ?"
    ).bind(productId).all<{ product_space_id: string; end_user_id: string; accessed_by: string; purpose: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]!.accessed_by).toBe("tenant-1");
    expect(rows.results[0]!.end_user_id).toBe(userId);
    expect(rows.results[0]!.purpose).toBe("support_ticket_42");
  });
});

describe("conversation-access gate — denied attempts write no audit trail", () => {
  it("a gate-1 denial (feature flag off) writes zero audit rows", async () => {
    const env = makeEnv();
    const { productId, userId } = await seedProduct(env, "tenant-1", { featureFlagOn: false, staffApproved: true, userConsented: true });
    await spacesWorker.fetch(await req(`/builder/products/${productId}/users/${userId}/conversations`, { tenant: "tenant-1" }), env as never, execCtx);
    const rows = await env.PLATFORM_DB.prepare("SELECT COUNT(*) AS n FROM conversation_access_audit").bind().all<{ n: number }>();
    expect(rows.results[0]!.n).toBe(0);
  });

  it("a gate-2 denial (no staff approval) writes zero audit rows", async () => {
    const env = makeEnv();
    const { productId, userId } = await seedProduct(env, "tenant-1", { featureFlagOn: true, staffApproved: false, userConsented: true });
    await spacesWorker.fetch(await req(`/builder/products/${productId}/users/${userId}/conversations`, { tenant: "tenant-1" }), env as never, execCtx);
    const rows = await env.PLATFORM_DB.prepare("SELECT COUNT(*) AS n FROM conversation_access_audit").bind().all<{ n: number }>();
    expect(rows.results[0]!.n).toBe(0);
  });

  it("a gate-3 denial (no user consent) writes zero audit rows", async () => {
    const env = makeEnv();
    const { productId, userId } = await seedProduct(env, "tenant-1", { featureFlagOn: true, staffApproved: true, userConsented: false });
    await spacesWorker.fetch(await req(`/builder/products/${productId}/users/${userId}/conversations`, { tenant: "tenant-1" }), env as never, execCtx);
    const rows = await env.PLATFORM_DB.prepare("SELECT COUNT(*) AS n FROM conversation_access_audit").bind().all<{ n: number }>();
    expect(rows.results[0]!.n).toBe(0);
  });
});

describe("conversation-access gate — ownership isolation", () => {
  it("a different tenant gets 404, never a gate-specific 403 that would confirm the product exists", async () => {
    const env = makeEnv();
    const { productId, userId } = await seedProduct(env, "tenant-1", { featureFlagOn: true, staffApproved: true, userConsented: true });
    const res = await spacesWorker.fetch(await req(`/builder/products/${productId}/users/${userId}/conversations`, { tenant: "tenant-2" }), env as never, execCtx);
    expect(res.status).toBe(404);
  });

  it("staff approval on one space does not leak to a different space owned by the same builder", async () => {
    const env = makeEnv();
    const approved = await seedProduct(env, "tenant-1", { featureFlagOn: true, staffApproved: true, userConsented: true });
    const unapproved = await seedProduct(env, "tenant-1", { featureFlagOn: true, staffApproved: false, userConsented: true });

    const okRes = await spacesWorker.fetch(await req(`/builder/products/${approved.productId}/users/${approved.userId}/conversations`, { tenant: "tenant-1" }), env as never, execCtx);
    expect(okRes.status).toBe(200);

    const deniedRes = await spacesWorker.fetch(await req(`/builder/products/${unapproved.productId}/users/${unapproved.userId}/conversations`, { tenant: "tenant-1" }), env as never, execCtx);
    expect(deniedRes.status).toBe(403);
  });
});
