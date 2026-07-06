import { describe, it, expect, vi } from "vitest";
import spacesWorker from "../../workers/spaces/src/index.js";
import { mintInternalToken } from "@naelao/http";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { makeStatefulDoNamespace } from "./helpers/fake-do-namespace.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

// WS-7 (audit plan): resolveEndUserBusinessRole ran 1-2 PLATFORM_DB reads on EVERY business-scoped
// end-user request — a real chokepoint on single-instance D1 at scale. requireBusinessMembership
// now wraps the lookup in a short-TTL (5s) in-memory cache, mirroring the router's own per-user
// token-version cache. Proven here at the D1-call-count level (not just status codes) so a
// regression that silently drops the cache would actually fail this test.

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
  fakeDb.db.exec(
    "INSERT INTO spaces (id, tenant_id, status, name, parent_space_id) VALUES ('biz-1', 'tenant-1', 'active', 'Biz', 'prod-root')"
  );
  fakeDb.db.exec(
    "INSERT INTO business_memberships (business_space_id, product_space_id, end_user_id, role, status) VALUES ('biz-1', 'prod-root', 'cache-test-user', 'admin', 'active')"
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
  };
}

async function req(path: string, method = "GET"): Promise<Request> {
  const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
  return new Request(`https://spaces.naelao.com${path}`, {
    method,
    headers: {
      "x-naelao-tenant-id": "tenant-1",
      "x-naelao-internal-token": token,
      "x-naelao-role": "product_end_user",
      "x-naelao-user-id": "cache-test-user",
    },
  });
}

describe("requireBusinessMembership — short-TTL role cache (WS-7)", () => {
  it("does not re-query PLATFORM_DB for a repeat request within the TTL window", async () => {
    const { env, prepareSpy } = makeEnv();

    const res1 = await spacesWorker.fetch(await req("/spaces/biz-1/projects"), env as never, execCtx);
    expect(res1.status).toBe(200);
    const queriesAfterFirst = prepareSpy.mock.calls.filter(([sql]: [string]) =>
      /parent_space_id FROM spaces|business_memberships/.test(sql)
    ).length;
    expect(queriesAfterFirst).toBeGreaterThan(0);

    const res2 = await spacesWorker.fetch(await req("/spaces/biz-1/projects"), env as never, execCtx);
    expect(res2.status).toBe(200);
    const queriesAfterSecond = prepareSpy.mock.calls.filter(([sql]: [string]) =>
      /parent_space_id FROM spaces|business_memberships/.test(sql)
    ).length;
    // The second call must not have issued any NEW role-lookup queries — same count as after the first.
    expect(queriesAfterSecond).toBe(queriesAfterFirst);
  });
});
