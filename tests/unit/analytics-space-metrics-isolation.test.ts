import { describe, it, expect } from "vitest";
import analyticsWorker from "../../workers/analytics/src/index.js";
import { mintInternalToken } from "@naelao/http";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

// WS-7 (audit plan): GET /metrics/space/:spaceId had no auth of its own (not even the
// header-trust check every other internal worker had before its HMAC hardening pass), and its
// KV cache key didn't fold in tenantId — a caller reaching this worker with a spaceId it didn't
// own could read another tenant's cached metrics for up to 5 minutes. Now gated with
// requireInternalHmac + a real ownership check, and the cache key is tenant-scoped.

const SECRET = "test-platform-secret";
const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const SPACES_TABLE_SQL = `
  CREATE TABLE spaces (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active');
`;

function makeEnv() {
  const fakeDb = createFakeD1([SPACES_TABLE_SQL]);
  fakeDb.db.exec(`INSERT INTO spaces (id, tenant_id, status) VALUES ('space-1', 'tenant-1', 'active')`);
  fakeDb.db.exec(`INSERT INTO spaces (id, tenant_id, status) VALUES ('space-2', 'tenant-2', 'active')`);

  const kvStore = new Map<string, string>();
  const kv = {
    async get(key: string) { return kvStore.get(key) ?? null; },
    async put(key: string, value: string) { kvStore.set(key, value); },
  };

  return {
    env: {
      ENVIRONMENT: "test",
      CF_ACCOUNT_ID: "acct",
      CF_ANALYTICS_API_TOKEN: "tok",
      ANALYTICS: { writeDataPoint() {} },
      METRICS_CACHE: kv,
      PLATFORM_SECRET: SECRET,
      PLATFORM_DB: fakeDb,
    },
    kvStore,
  };
}

async function req(path: string, tenantId: string, opts: { noToken?: boolean } = {}): Promise<Request> {
  const headers: Record<string, string> = { "x-naelao-tenant-id": tenantId };
  if (!opts.noToken) headers["x-naelao-internal-token"] = await mintInternalToken(SECRET, tenantId);
  return new Request(`https://analytics.naelao.com${path}`, { headers });
}

describe("analytics worker — /metrics/space/:spaceId isolation (WS-7)", () => {
  it("rejects a request with no internal token", async () => {
    const { env } = makeEnv();
    const res = await analyticsWorker.fetch(
      await req("/metrics/space/space-1", "tenant-1", { noToken: true }),
      env as never, execCtx
    );
    expect(res.status).toBe(403);
  });

  it("rejects a tenant querying a spaceId it doesn't own", async () => {
    const { env } = makeEnv();
    const res = await analyticsWorker.fetch(await req("/metrics/space/space-2", "tenant-1"), env as never, execCtx);
    expect(res.status).toBe(404);
  });

  it("never serves tenant-1's cached response back to tenant-2 for a same-name spaceId collision", async () => {
    const { env, kvStore } = makeEnv();
    // Simulate a pre-existing cache entry for a DIFFERENT tenant somehow sharing the same key
    // shape as the OLD (non-tenant-scoped) cache key would have produced.
    kvStore.set("metrics:space:space-1:30", JSON.stringify({ leaked: true }));
    // tenant-1 legitimately owns space-1 — its own (correctly tenant-scoped) cache key must be
    // a cache MISS here since nothing populated it yet, proving the old shared key is dead.
    const res = await analyticsWorker.fetch(await req("/metrics/space/space-1", "tenant-1"), env as never, execCtx);
    // 503 expected (no real CF_ANALYTICS creds in the test env) — the assertion that matters is
    // that this did NOT come back as the poisoned "leaked" cache entry.
    const body = await res.json() as Record<string, unknown>;
    expect(body.leaked).toBeUndefined();
  });
});
