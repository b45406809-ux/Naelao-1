import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import spacesWorker from "../../workers/spaces/src/index.js";
import { BuilderAccountDO } from "../../workers/spaces/src/do/BuilderAccountDO.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
import { makeStatefulDoNamespace } from "./helpers/fake-do-namespace.js";
import { mintInternalToken } from "@naelao/http";

// Team API-key routes and generic Space creation. Exercise the real spaces worker through Hono's
// fetch(), backed by BuilderAccountDO and a real-SQLite D1.

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const SPACES_TABLE_SQL = `
  CREATE TABLE spaces (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', suspension_reason TEXT,
    name TEXT NOT NULL DEFAULT '', spacetype_id TEXT NOT NULL DEFAULT 'workspace',
    config_json TEXT NOT NULL DEFAULT '{}', parent_space_id TEXT, depth INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), created_by TEXT
  );
  -- createSpaceRecord (create-space.ts) queries these; real schema per 0002_orgs.sql / 0003_spaces.sql.
  CREATE TABLE orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', owner_id TEXT NOT NULL DEFAULT '', plan_tier TEXT NOT NULL DEFAULT 'free', status TEXT NOT NULL DEFAULT 'active', suspension_reason TEXT);
  CREATE TABLE spacetypes (id TEXT PRIMARY KEY, schema_json TEXT);
`;
const BUILDER_DASHBOARD_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0045_builder_dashboard_api.sql"), "utf8");
const GDPR_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0025_gdpr_requests.sql"), "utf8");
const ERASURE_OUTBOX_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0118_gdpr_erasure_outbox.sql"), "utf8");

function makeEnv() {
  const fakeDb = createFakeD1([SPACES_TABLE_SQL, GDPR_MIGRATION, ERASURE_OUTBOX_MIGRATION, BUILDER_DASHBOARD_MIGRATION]);
  const events: unknown[] = [];
  return {
    PLATFORM_SECRET: "s",
    NAELAO_DASHBOARD_TENANT_ID: "tenant-1",
    ENVIRONMENT: "test",
    PLATFORM_DB: fakeDb,
    EVENTS_QUEUE: { send: async (message: unknown) => { events.push(message); } },
    _events: events,
    BUILDER_ACCOUNT_DO: makeStatefulDoNamespace(BuilderAccountDO),
    NAELAO_CONFIG_KV: { get: async () => null, put: async () => {} },
  };
}

async function req(path: string, opts: { method?: string; body?: unknown; tenant?: string; bearer?: string; role?: string; userId?: string } = {}): Promise<Request> {
  const headers = new Headers();
  if (opts.tenant) {
    headers.set("x-naelao-tenant-id", opts.tenant);
    headers.set("x-naelao-internal-token", await mintInternalToken("s", opts.tenant));
    headers.set("x-naelao-role", opts.role ?? "owner");
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
    const res = await spacesWorker.fetch(await req("/builder/api-keys"), env as never, execCtx);
    expect(res.status).toBe(401);
  });

  it("rejects a forged tenant header without the router signature", async () => {
    const env = makeEnv();
    const res = await spacesWorker.fetch(new Request("https://spaces.naelao.com/builder/api-keys", {
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
    const res = await spacesWorker.fetch(await req("/builder/api-keys", { tenant: "tenant-1" }), env as never, execCtx);
    expect(res.status).toBe(200);
  });

  it("a minted nbk_ key authenticates as its own builder, distinct from other tenants", async () => {
    const env = makeEnv();
    const created = await (await spacesWorker.fetch(
      await req("/builder/api-keys", { method: "POST", tenant: "tenant-1", body: { name: "CI", scopes: ["spaces:read"] } }),
      env as never, execCtx
    )).json() as { key: string };
    expect(created.key).toMatch(/^nbk_/);

    const viaKey = await spacesWorker.fetch(await req("/builder/api-keys", { bearer: created.key }), env as never, execCtx);
    expect(viaKey.status).toBe(200);
  });

  it("enforces API-key scopes and prevents a key from minting broader child scopes", async () => {
    const env = makeEnv();
    const readKey = await (await spacesWorker.fetch(
      await req("/builder/api-keys", { method: "POST", tenant: "tenant-1", body: { name: "Read", scopes: ["spaces:read"] } }),
      env as never, execCtx
    )).json() as { key: string };
    expect((await spacesWorker.fetch(await req("/builder/api-keys", { bearer: readKey.key }), env as never, execCtx)).status).toBe(200);
    expect((await spacesWorker.fetch(await req("/builder/api-keys", { method: "POST", bearer: readKey.key, body: { name: "No", scopes: ["spaces:write"] } }), env as never, execCtx)).status).toBe(403);

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
    const res = await spacesWorker.fetch(await req("/builder/api-keys", { bearer: "nbk_totallyforged" }), env as never, execCtx);
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
    const viaKey = await spacesWorker.fetch(await req("/builder/api-keys", { bearer: created.key }), env as never, execCtx);
    expect(viaKey.status).toBe(401);
  });
});

describe("retired root-product creation route", () => {
  it("rejects all root-product creation requests without inserting a row", async () => {
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

    expect(malformed.status).toBe(410);
    expect(oversized.status).toBe(410);
    const count = await env.PLATFORM_DB.prepare("SELECT COUNT(*) AS count FROM spaces").first<{ count: number }>();
    expect(count?.count).toBe(0);
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
