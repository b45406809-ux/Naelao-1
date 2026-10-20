import { describe, it, expect } from "vitest";
import spacesWorker from "../../workers/spaces/src/index.js";
import { mintInternalToken } from "@naelao/http";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { makeStatefulDoNamespace } from "./helpers/fake-do-namespace.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

// Three-Tier Platform Model (§A1.17): requireBusinessMembership adds a floor for product_end_user
// callers on routes that were previously builder-only (projects, threads, agent-definitions,
// presence) — additive only, every other role's access must stay unchanged. All tests in this
// file operate on "prod-1", a PRODUCT ROOT space (no parent_space_id) — a verified product
// session for that exact space implies "member" (resolveEndUserBusinessRole's product-root
// branch). Cross-business membership enforcement (a business space with parent_space_id set,
// requiring a real business_memberships row) is covered in business-membership-role.test.ts.

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

function makeEnv() {
  const fakeDb = createFakeD1([SPACES_TABLE_SQL, BUSINESS_MEMBERSHIPS_SQL, SPACE_MEMBERS_SQL]);
  fakeDb.db.exec("INSERT INTO spaces (id, tenant_id, status, name) VALUES ('prod-1', 'tenant-1', 'active', 'Product Root')");
  fakeDb.db.exec("INSERT INTO space_members (id, space_id, end_user_id, role) VALUES ('member-1', 'prod-1', 'eu-1', 'member')");
  return {
    PLATFORM_SECRET,
    ENVIRONMENT: "test",
    SPACE_DO: makeStatefulDoNamespace(SpaceDO),
    PLATFORM_DB: fakeDb,
  };
}

async function internalHeaders(tenantId: string, extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const token = await mintInternalToken(PLATFORM_SECRET, tenantId);
  return { "content-type": "application/json", "x-naelao-tenant-id": tenantId, "x-naelao-internal-token": token, ...extra };
}

function req(path: string, headers: Record<string, string>, init?: RequestInit): Request {
  return new Request(`https://spaces.naelao.com${path}`, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) } });
}

describe("requireBusinessMembership — projects", () => {
  it("a product_end_user can list and create projects (member floor)", async () => {
    const env = makeEnv();
    const listRes = await spacesWorker.fetch(
      req("/spaces/prod-1/projects", await internalHeaders("tenant-1", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "eu-1" })),
      env as never, execCtx
    );
    expect(listRes.status).toBe(200);

    const createRes = await spacesWorker.fetch(
      req("/spaces/prod-1/projects", await internalHeaders("tenant-1", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "eu-1" }), {
        method: "POST",
        body: JSON.stringify({ name: "My Project" }),
      }),
      env as never, execCtx
    );
    expect(createRes.status).toBe(201);
  });

  it("a product_end_user can GET a single project but NOT PATCH it (admin floor)", async () => {
    const env = makeEnv();
    const headers = await internalHeaders("tenant-1", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "eu-1" });
    const created = await spacesWorker.fetch(
      req("/spaces/prod-1/projects", headers, { method: "POST", body: JSON.stringify({ name: "P" }) }),
      env as never, execCtx
    );
    const { id: projectId } = await created.json() as { id: string };

    const getRes = await spacesWorker.fetch(req(`/spaces/prod-1/projects/${projectId}`, headers), env as never, execCtx);
    expect(getRes.status).toBe(200);

    const patchRes = await spacesWorker.fetch(
      req(`/spaces/prod-1/projects/${projectId}`, headers, { method: "PATCH", body: JSON.stringify({ name: "Renamed" }) }),
      env as never, execCtx
    );
    expect(patchRes.status).toBe(403);
  });

  it("a builder role (owner) is completely unaffected — can still PATCH", async () => {
    const env = makeEnv();
    const builderHeaders = await internalHeaders("tenant-1", { "x-naelao-role": "owner", "x-naelao-user-id": "builder-1" });
    const created = await spacesWorker.fetch(
      req("/spaces/prod-1/projects", builderHeaders, { method: "POST", body: JSON.stringify({ name: "P" }) }),
      env as never, execCtx
    );
    const { id: projectId } = await created.json() as { id: string };
    const patchRes = await spacesWorker.fetch(
      req(`/spaces/prod-1/projects/${projectId}`, builderHeaders, { method: "PATCH", body: JSON.stringify({ name: "Renamed" }) }),
      env as never, execCtx
    );
    expect(patchRes.status).toBe(200);
  });
});

describe("requireBusinessMembership — threads", () => {
  it("a product_end_user can list and create threads, and GET a single thread", async () => {
    const env = makeEnv();
    const headers = await internalHeaders("tenant-1", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "eu-1" });
    const createRes = await spacesWorker.fetch(
      req("/spaces/prod-1/threads", headers, { method: "POST", body: JSON.stringify({ title: "Hi" }) }),
      env as never, execCtx
    );
    expect(createRes.status).toBe(201);
    const { id: threadId } = await createRes.json() as { id: string };

    const listRes = await spacesWorker.fetch(req("/spaces/prod-1/threads", headers), env as never, execCtx);
    expect(listRes.status).toBe(200);

    const getRes = await spacesWorker.fetch(req(`/spaces/prod-1/threads/${threadId}`, headers), env as never, execCtx);
    expect(getRes.status).toBe(200);
  });

  it("a product_end_user can GET a thread but NOT PATCH it (admin floor — same convention as projects)", async () => {
    const env = makeEnv();
    const headers = await internalHeaders("tenant-1", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "eu-1" });
    const created = await spacesWorker.fetch(
      req("/spaces/prod-1/threads", headers, { method: "POST", body: JSON.stringify({ title: "Hi" }) }),
      env as never, execCtx
    );
    const { id: threadId } = await created.json() as { id: string };

    const patchRes = await spacesWorker.fetch(
      req(`/spaces/prod-1/threads/${threadId}`, headers, { method: "PATCH", body: JSON.stringify({ title: "Renamed" }) }),
      env as never, execCtx
    );
    expect(patchRes.status).toBe(403);
  });

  it("a builder role (owner) can rename and archive a thread via PATCH", async () => {
    const env = makeEnv();
    const builderHeaders = await internalHeaders("tenant-1", { "x-naelao-role": "owner", "x-naelao-user-id": "builder-1" });
    const created = await spacesWorker.fetch(
      req("/spaces/prod-1/threads", builderHeaders, { method: "POST", body: JSON.stringify({ title: "Hi" }) }),
      env as never, execCtx
    );
    const { id: threadId } = await created.json() as { id: string };

    const patchRes = await spacesWorker.fetch(
      req(`/spaces/prod-1/threads/${threadId}`, builderHeaders, { method: "PATCH", body: JSON.stringify({ title: "Renamed", status: "archived" }) }),
      env as never, execCtx
    );
    expect(patchRes.status).toBe(200);
    const body = await patchRes.json() as { title: string; status: string };
    expect(body.title).toBe("Renamed");
    expect(body.status).toBe("archived");
  });
});

describe("requireBusinessMembership — agent-definitions (read-only for product_end_user)", () => {
  it("a product_end_user can GET agent-definitions but not POST", async () => {
    const env = makeEnv();
    const headers = await internalHeaders("tenant-1", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "eu-1" });
    const getRes = await spacesWorker.fetch(req("/spaces/prod-1/agent-definitions", headers), env as never, execCtx);
    expect(getRes.status).toBe(200);

    const postRes = await spacesWorker.fetch(
      req("/spaces/prod-1/agent-definitions", headers, { method: "POST", body: JSON.stringify({ agent_id: "x", config: {} }) }),
      env as never, execCtx
    );
    expect(postRes.status).toBe(403);
  });

  it("a builder role can still write agent-definitions", async () => {
    const env = makeEnv();
    const headers = await internalHeaders("tenant-1", { "x-naelao-role": "owner", "x-naelao-user-id": "builder-1" });
    const postRes = await spacesWorker.fetch(
      req("/spaces/prod-1/agent-definitions", headers, { method: "POST", body: JSON.stringify({ agent_id: "x", config: {} }) }),
      env as never, execCtx
    );
    expect(postRes.status).not.toBe(403);
  });
});

describe("requireBusinessMembership — presence", () => {
  it("a product_end_user can POST and GET presence", async () => {
    const env = makeEnv();
    const headers = await internalHeaders("tenant-1", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "eu-1" });
    const postRes = await spacesWorker.fetch(req("/spaces/prod-1/presence", headers, { method: "POST", body: "{}" }), env as never, execCtx);
    expect(postRes.status).toBe(200);
    const getRes = await spacesWorker.fetch(req("/spaces/prod-1/presence", headers), env as never, execCtx);
    expect(getRes.status).toBe(200);
  });
});
