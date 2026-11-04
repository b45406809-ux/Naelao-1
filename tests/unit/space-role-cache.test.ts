import { describe, it, expect, vi } from "vitest";
import spacesWorker from "../../workers/spaces/src/index.js";
import { mintInternalToken } from "@naelao/http";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { makeStatefulDoNamespace } from "./helpers/fake-do-namespace.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

// Membership authorization intentionally queries current D1 state on every protected request.
// A positive in-memory cache can let a revoked member continue accessing a Space from a warm
// isolate; correctness and immediate revocation take precedence over saving these reads.

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
const SPACE_MEMBERS_SQL = `
  CREATE TABLE space_members (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL, end_user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member', suspended_at TEXT
  );
`;

function makeEnv(tenantId = "tenant-1", authorized = true) {
  const fakeDb = createFakeD1([SPACES_TABLE_SQL, SPACE_MEMBERS_SQL]);
  fakeDb.db.exec(`INSERT INTO spaces (id, tenant_id, status, name) VALUES ('space-1', '${tenantId}', 'active', 'Space')`);
  if (authorized) fakeDb.db.exec(
    "INSERT INTO space_members (id, space_id, end_user_id, role) VALUES ('membership-1', 'space-1', 'cache-test-user', 'admin')"
  );

  const realPrepare = fakeDb.prepare.bind(fakeDb);
  const prepareSpy = vi.fn((sql: string) => realPrepare(sql));
  const dbWithSpy = new Proxy(fakeDb, {
    get(target, prop) {
      if (prop === "prepare") return prepareSpy;
      return (target as unknown as Record<string, unknown>)[prop as string];
    },
  });

  return {
    env: { PLATFORM_SECRET, ENVIRONMENT: "test", PLATFORM_DB: dbWithSpy, SPACE_DO: makeStatefulDoNamespace(SpaceDO) },
    prepareSpy,
    revokeMembership: () => fakeDb.prepare("DELETE FROM space_members WHERE space_id = ? AND end_user_id = ?").bind("space-1", "cache-test-user").run(),
  };
}

async function req(path: string, method = "GET", tenantId = "tenant-1"): Promise<Request> {
  const token = await mintInternalToken(PLATFORM_SECRET, tenantId);
  return new Request(`https://spaces.naelao.com${path}`, {
    method,
    headers: {
      "x-naelao-tenant-id": tenantId,
      "x-naelao-internal-token": token,
      "x-naelao-role": "product_end_user",
      "x-naelao-user-id": "cache-test-user",
    },
  });
}

describe("requireSpaceMembership — immediate membership revocation", () => {
  it("re-queries D1 and denies access on the first request after membership removal", async () => {
    const { env, prepareSpy, revokeMembership } = makeEnv();

    const res1 = await spacesWorker.fetch(await req("/spaces/space-1/projects"), env as never, execCtx);
    expect(res1.status).toBe(200);
    const queriesAfterFirst = prepareSpy.mock.calls.filter(([sql]: [string]) =>
      /space_members|FROM spaces WHERE id/.test(sql)
    ).length;
    expect(queriesAfterFirst).toBe(1);

    await revokeMembership();
    const res2 = await spacesWorker.fetch(await req("/spaces/space-1/projects"), env as never, execCtx);
    expect(res2.status).toBe(403);
    const queriesAfterSecond = prepareSpy.mock.calls.filter(([sql]: [string]) =>
      /space_members|FROM spaces WHERE id/.test(sql)
    ).length;
    expect(queriesAfterSecond).toBeGreaterThan(queriesAfterFirst);
  });

  it("does not authorize a Space request with a mismatched tenant identity", async () => {
    const authorized = makeEnv("tenant-cache-a", true);
    const denied = makeEnv("tenant-cache-b", false);
    const first = await spacesWorker.fetch(await req("/spaces/space-1/projects", "GET", "tenant-cache-a"), authorized.env as never, execCtx);
    expect(first.status).toBe(200);
    const second = await spacesWorker.fetch(await req("/spaces/space-1/projects", "GET", "tenant-cache-b"), denied.env as never, execCtx);
    expect(second.status).toBe(403);
  });
});
