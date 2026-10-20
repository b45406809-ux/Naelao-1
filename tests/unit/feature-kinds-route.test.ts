// GET /spaces/:spaceId/feature-kinds — the "plugins directory" wrapper. Drives the REAL
// spacesWorker through a REAL stateful SpaceDO AND the REAL agentsWorker app (wired as the
// AGENTS_WORKER binding), proving the full chain end to end: requireBusinessMembership gate →
// resolveEndUserBusinessRole → businessRoleToFeatureKindRole → proxyToAgentsWorker →
// creatableFeatureKindsForRole's real role filtering.

import { describe, it, expect } from "vitest";
import spacesWorker from "../../workers/spaces/src/index.js";
import { app as agentsApp } from "../../workers/agents/src/index.js";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { mintInternalToken } from "@naelao/http";
import { makeStatefulDoNamespace } from "./helpers/fake-do-namespace.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

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
  fakeDb.db.exec("INSERT INTO spaces (id, tenant_id, status, name) VALUES ('prod-root', 'tenant-1', 'active', 'Product')");
  fakeDb.db.exec("INSERT INTO spaces (id, tenant_id, status, name, parent_space_id) VALUES ('biz-alice', 'tenant-1', 'active', 'Alice Biz', 'prod-root')");
  fakeDb.db.exec("INSERT INTO business_memberships (business_space_id, product_space_id, end_user_id, role, status) VALUES ('biz-alice', 'prod-root', 'owner-user', 'owner', 'active')");
  fakeDb.db.exec("INSERT INTO business_memberships (business_space_id, product_space_id, end_user_id, role, status) VALUES ('biz-alice', 'prod-root', 'admin-user', 'admin', 'active')");
  fakeDb.db.exec("INSERT INTO business_memberships (business_space_id, product_space_id, end_user_id, role, status) VALUES ('biz-alice', 'prod-root', 'plain-member', 'member', 'active')");
  fakeDb.db.exec("INSERT INTO business_memberships (business_space_id, product_space_id, end_user_id, role, status) VALUES ('biz-alice', 'prod-root', 'watcher', 'viewer', 'active')");

  // Real agentsWorker app wired as AGENTS_WORKER — proxyToAgentsWorker mints its own internal
  // token per call, so the agents-worker env only needs what /project-templates itself reads.
  const agentsEnv = { PLATFORM_SECRET } as unknown as Parameters<typeof agentsApp.fetch>[1];
  const agentsWorkerFetcher = { fetch: (req: Request) => agentsApp.fetch(req, agentsEnv, execCtx) };

  return {
    PLATFORM_SECRET,
    ENVIRONMENT: "test",
    SPACE_DO: makeStatefulDoNamespace(SpaceDO),
    PLATFORM_DB: fakeDb,
    AGENTS_WORKER: agentsWorkerFetcher,
  };
}

async function endUserHeaders(endUserId: string): Promise<Record<string, string>> {
  const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
  return {
    "content-type": "application/json",
    "x-naelao-tenant-id": "tenant-1",
    "x-naelao-internal-token": token,
    "x-naelao-role": "product_end_user",
    "x-naelao-user-id": endUserId,
  };
}

function req(path: string, headers: Record<string, string>): Request {
  return new Request(`https://spaces.naelao.com${path}`, { headers });
}

describe("GET /spaces/:spaceId/feature-kinds — the plugins directory", () => {
  it("an owner sees every feature kind, including owner/admin-tier ones like Wallet", async () => {
    const env = makeEnv();
    const res = await spacesWorker.fetch(req("/spaces/biz-alice/feature-kinds", await endUserHeaders("owner-user")), env as never, execCtx);
    expect(res.status).toBe(200);
    const body = await res.json<{ feature_kinds: Array<{ kind: string }> }>();
    expect(body.feature_kinds.some((k) => k.kind === "wallet")).toBe(true);
  });

  it("a plain member sees editor-tier kinds (CRM) but NOT admin-tier ones (Wallet)", async () => {
    const env = makeEnv();
    const res = await spacesWorker.fetch(req("/spaces/biz-alice/feature-kinds", await endUserHeaders("plain-member")), env as never, execCtx);
    expect(res.status).toBe(200);
    const body = await res.json<{ feature_kinds: Array<{ kind: string }> }>();
    const kinds = body.feature_kinds.map((k) => k.kind);
    expect(kinds).toContain("crm"); // minCreationRole: "editor" — "member" maps onto this
    expect(kinds).not.toContain("wallet"); // minCreationRole: "admin" — a plain member is below it
  });

  it("a viewer is refused at the membership gate itself — 'viewer' is below this route's own 'member' floor", async () => {
    const env = makeEnv();
    const res = await spacesWorker.fetch(req("/spaces/biz-alice/feature-kinds", await endUserHeaders("watcher")), env as never, execCtx);
    expect(res.status).toBe(403);
  });

  it("a non-member of this business is refused outright", async () => {
    const env = makeEnv();
    const res = await spacesWorker.fetch(req("/spaces/biz-alice/feature-kinds", await endUserHeaders("stranger")), env as never, execCtx);
    expect(res.status).toBe(403);
  });

  it("only exposes feature_kinds — not the unrelated no-code project-template catalogue behind it", async () => {
    const env = makeEnv();
    const res = await spacesWorker.fetch(req("/spaces/biz-alice/feature-kinds", await endUserHeaders("owner-user")), env as never, execCtx);
    const body = await res.json<Record<string, unknown>>();
    expect(body).toHaveProperty("feature_kinds");
    expect(body).toHaveProperty("count");
    expect(body).not.toHaveProperty("data"); // /project-templates' own no-code catalogue field
  });
});
