import { describe, it, expect } from "vitest";
import spacesWorker from "../../workers/spaces/src/index.js";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { mintInternalToken } from "@naelao/http";
import { makeStatefulDoNamespace } from "./helpers/fake-do-namespace.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

// §A1.17 Phase S: a business's own end-user member can grant the assistant access to THEIR OWN
// machine — but only within the business they actually belong to, and only their own grants are
// visible to them (directory paths are sensitive). requireInternalHmac alone (Phase M's original
// gate) doesn't provide this: naelao-router mints that same token for EVERY authenticated
// request it proxies, builder JWT or product_end_user alike, so without requireBusinessMembership
// any end user of ANY business under the same owning tenant could reach another business's grants.

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

function makeEnv() {
  const fakeDb = createFakeD1([SPACES_TABLE_SQL, BUSINESS_MEMBERSHIPS_SQL]);
  fakeDb.db.exec("INSERT INTO spaces (id, tenant_id, status, name) VALUES ('prod-root', 'tenant-1', 'active', 'Product')");
  fakeDb.db.exec("INSERT INTO spaces (id, tenant_id, status, name, parent_space_id) VALUES ('biz-alice', 'tenant-1', 'active', 'Alice Biz', 'prod-root')");
  fakeDb.db.exec("INSERT INTO spaces (id, tenant_id, status, name, parent_space_id) VALUES ('biz-bob', 'tenant-1', 'active', 'Bob Biz', 'prod-root')");
  fakeDb.db.exec("INSERT INTO business_memberships (business_space_id, product_space_id, end_user_id, role, status) VALUES ('biz-alice', 'prod-root', 'alice', 'admin', 'active')");
  fakeDb.db.exec("INSERT INTO business_memberships (business_space_id, product_space_id, end_user_id, role, status) VALUES ('biz-alice', 'prod-root', 'alice-member', 'member', 'active')");
  fakeDb.db.exec("INSERT INTO business_memberships (business_space_id, product_space_id, end_user_id, role, status) VALUES ('biz-bob', 'prod-root', 'bob', 'admin', 'active')");
  return {
    PLATFORM_SECRET,
    ENVIRONMENT: "test",
    SPACE_DO: makeStatefulDoNamespace(SpaceDO),
    PLATFORM_DB: fakeDb,
  };
}

async function endUserHeaders(tenantId: string, endUserId: string): Promise<Record<string, string>> {
  const token = await mintInternalToken(PLATFORM_SECRET, tenantId);
  return {
    "content-type": "application/json",
    "x-naelao-tenant-id": tenantId,
    "x-naelao-internal-token": token,
    "x-naelao-role": "product_end_user",
    "x-naelao-user-id": endUserId,
  };
}

function req(path: string, headers: Record<string, string>, init?: RequestInit): Request {
  return new Request(`https://spaces.naelao.com${path}`, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) } });
}

describe("local-grants — business membership gate (§A1.17 Phase S)", () => {
  it("an admin member of the business can create a grant for their own machine", async () => {
    const env = makeEnv();
    const headers = await endUserHeaders("tenant-1", "alice");
    const res = await spacesWorker.fetch(
      req("/spaces/biz-alice/local-grants", headers, { method: "POST", body: JSON.stringify({ grant_type: "read", directory: "/home/alice/repo" }) }),
      env as never, execCtx
    );
    expect(res.status).toBe(201);
  });

  it("a plain member (not admin) cannot create a grant", async () => {
    const env = makeEnv();
    const headers = await endUserHeaders("tenant-1", "alice-member");
    const res = await spacesWorker.fetch(
      req("/spaces/biz-alice/local-grants", headers, { method: "POST", body: JSON.stringify({ grant_type: "read", directory: "/home/alice-member/repo" }) }),
      env as never, execCtx
    );
    expect(res.status).toBe(403);
  });

  it("CRITICAL: a member of a DIFFERENT business cannot create or list grants for this one", async () => {
    const env = makeEnv();
    const bobHeaders = await endUserHeaders("tenant-1", "bob");
    const createRes = await spacesWorker.fetch(
      req("/spaces/biz-alice/local-grants", bobHeaders, { method: "POST", body: JSON.stringify({ grant_type: "read", directory: "/home/bob/repo" }) }),
      env as never, execCtx
    );
    expect(createRes.status).toBe(403);

    const listRes = await spacesWorker.fetch(req("/spaces/biz-alice/local-grants", bobHeaders), env as never, execCtx);
    expect(listRes.status).toBe(403);
  });

  it("a member only ever sees their OWN grants, never another member's", async () => {
    const env = makeEnv();
    const aliceHeaders = await endUserHeaders("tenant-1", "alice");
    await spacesWorker.fetch(
      req("/spaces/biz-alice/local-grants", aliceHeaders, { method: "POST", body: JSON.stringify({ grant_type: "read", directory: "/home/alice/repo" }) }),
      env as never, execCtx
    );

    // alice-member has no grants of their own — the list must come back empty, not alice's.
    const memberHeaders = await endUserHeaders("tenant-1", "alice-member");
    const listRes = await spacesWorker.fetch(req("/spaces/biz-alice/local-grants", memberHeaders), env as never, execCtx);
    expect(listRes.status).toBe(200);
    const body = await listRes.json<{ data: unknown[] }>();
    expect(body.data).toEqual([]);
  });

  it("a builder JWT-style caller (no x-naelao-role) is unaffected — sees the whole space's grants", async () => {
    const env = makeEnv();
    const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
    const aliceHeaders = await endUserHeaders("tenant-1", "alice");
    await spacesWorker.fetch(
      req("/spaces/biz-alice/local-grants", aliceHeaders, { method: "POST", body: JSON.stringify({ grant_type: "read", directory: "/home/alice/repo" }) }),
      env as never, execCtx
    );

    const builderHeaders = { "content-type": "application/json", "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token };
    const listRes = await spacesWorker.fetch(req("/spaces/biz-alice/local-grants", builderHeaders), env as never, execCtx);
    expect(listRes.status).toBe(200);
    const body = await listRes.json<{ data: Array<{ user_id: string }> }>();
    expect(body.data.map((g) => g.user_id)).toEqual(["alice"]);
  });

  it("a member (not admin) CAN mint a local-tunnel connect token for their own machine", async () => {
    const env = makeEnv();
    const headers = await endUserHeaders("tenant-1", "alice-member");
    const res = await spacesWorker.fetch(req("/spaces/biz-alice/local-tunnel/connect-token", headers, { method: "POST" }), env as never, execCtx);
    expect(res.status).toBe(200);
    const body = await res.json<{ user_id: string }>();
    expect(body.user_id).toBe("alice-member");
  });

  it("a non-member cannot mint a connect token for someone else's business", async () => {
    const env = makeEnv();
    const bobHeaders = await endUserHeaders("tenant-1", "bob");
    const res = await spacesWorker.fetch(req("/spaces/biz-alice/local-tunnel/connect-token", bobHeaders, { method: "POST" }), env as never, execCtx);
    expect(res.status).toBe(403);
  });

  // Phase 5 plugins/skills batch — a project-scoped Local Machine side-panel tab needs ?project_id=
  // to show only what would actually apply to a run in THAT project (its own grants plus every
  // space-wide one — mirrors local-machine.ts's own grant-resolution rule exactly).
  it("?project_id= returns this project's own grants PLUS space-wide ones, never a different project's", async () => {
    const env = makeEnv();
    const aliceHeaders = await endUserHeaders("tenant-1", "alice"); // POST uses the CALLER's own identity, not a body field
    await spacesWorker.fetch(
      req("/spaces/biz-alice/local-grants", aliceHeaders, { method: "POST", body: JSON.stringify({ grant_type: "read", directory: "/space-wide" }) }),
      env as never, execCtx
    );
    await spacesWorker.fetch(
      req("/spaces/biz-alice/local-grants", aliceHeaders, { method: "POST", body: JSON.stringify({ grant_type: "read", directory: "/proj-a-only", project_id: "proj-a" }) }),
      env as never, execCtx
    );
    await spacesWorker.fetch(
      req("/spaces/biz-alice/local-grants", aliceHeaders, { method: "POST", body: JSON.stringify({ grant_type: "read", directory: "/proj-b-only", project_id: "proj-b" }) }),
      env as never, execCtx
    );

    const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
    const builderHeaders = { "content-type": "application/json", "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token };
    const res = await spacesWorker.fetch(req("/spaces/biz-alice/local-grants?project_id=proj-a", builderHeaders), env as never, execCtx);
    expect(res.status).toBe(200);
    const body = await res.json<{ data: Array<{ directory: string | null }> }>();
    const dirs = body.data.map((g) => g.directory).sort();
    expect(dirs).toEqual(["/proj-a-only", "/space-wide"]); // proj-b's own grant never leaks in
  });

  it("omitting ?project_id= keeps the whole-space view unchanged (business detail page's own use)", async () => {
    const env = makeEnv();
    const aliceHeaders = await endUserHeaders("tenant-1", "alice");
    await spacesWorker.fetch(
      req("/spaces/biz-alice/local-grants", aliceHeaders, { method: "POST", body: JSON.stringify({ grant_type: "read", directory: "/proj-a-only", project_id: "proj-a" }) }),
      env as never, execCtx
    );
    await spacesWorker.fetch(
      req("/spaces/biz-alice/local-grants", aliceHeaders, { method: "POST", body: JSON.stringify({ grant_type: "read", directory: "/proj-b-only", project_id: "proj-b" }) }),
      env as never, execCtx
    );

    const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
    const builderHeaders = { "content-type": "application/json", "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token };
    const res = await spacesWorker.fetch(req("/spaces/biz-alice/local-grants", builderHeaders), env as never, execCtx);
    const body = await res.json<{ data: Array<{ directory: string | null }> }>();
    expect(body.data.length).toBe(2); // everything, regardless of project
  });
});
