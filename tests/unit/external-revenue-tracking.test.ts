import { describe, it, expect } from "vitest";
import spacesWorker from "../../workers/spaces/src/index.js";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { makeStatefulDoNamespace } from "./helpers/fake-do-namespace.js";
import { mintInternalToken } from "@naelao/http";

// External revenue tracker (Whop-native business cut): a business whose sales happen on a
// platform Naelao never custodies money through (most commonly Whop) has no natural point for
// the P0-5 wallet-settlement mechanism to apply. This tracks that business's own reported gross
// revenue per period — real SpaceDO migration + routes, exercised through the actual spaces
// worker HTTP surface, same rigor as wallet-ledger.test.ts.

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const PLATFORM_SECRET = "test-platform-secret";

function makeEnv() {
  return {
    PLATFORM_SECRET,
    ENVIRONMENT: "test",
    SPACE_DO: makeStatefulDoNamespace(SpaceDO),
  };
}

async function headers(tenantId: string): Promise<Record<string, string>> {
  return {
    "content-type": "application/json",
    "x-naelao-tenant-id": tenantId,
    "x-naelao-internal-token": await mintInternalToken(PLATFORM_SECRET, tenantId),
  };
}

function req(path: string, h: Record<string, string>, init?: RequestInit): Request {
  return new Request(`https://spaces.naelao.com${path}`, { ...init, headers: { ...h, ...(init?.headers as Record<string, string> | undefined) } });
}

describe("POST/GET /spaces/:spaceId/revenue-tracking", () => {
  it("requires a verified internal token", async () => {
    const env = makeEnv();
    const res = await spacesWorker.fetch(
      new Request("https://spaces.naelao.com/spaces/space-1/revenue-tracking", { headers: { "x-naelao-tenant-id": "tenant-1" } }),
      env as never, execCtx
    );
    expect(res.status).toBe(403);
  });

  it("records a period's revenue and reads it back", async () => {
    const env = makeEnv();
    const h = await headers("tenant-1");
    const postRes = await spacesWorker.fetch(
      req("/spaces/space-1/revenue-tracking", h, { method: "POST", body: JSON.stringify({ period: "2026-07", revenue_cents: 50000 }) }),
      env as never, execCtx
    );
    expect(postRes.status).toBe(201);
    expect(await postRes.json()).toMatchObject({ period: "2026-07", provider: "whop", revenue_cents: 50000, billed: false });

    const getRes = await spacesWorker.fetch(req("/spaces/space-1/revenue-tracking?period=2026-07", h), env as never, execCtx);
    expect(await getRes.json()).toMatchObject({ revenue_cents: 50000, billed: false });
  });

  it("re-tracking the same period overwrites the prior observation (revenue can only grow within a period)", async () => {
    const env = makeEnv();
    const h = await headers("tenant-1");
    await spacesWorker.fetch(req("/spaces/space-1/revenue-tracking", h, { method: "POST", body: JSON.stringify({ period: "2026-07", revenue_cents: 10000 }) }), env as never, execCtx);
    await spacesWorker.fetch(req("/spaces/space-1/revenue-tracking", h, { method: "POST", body: JSON.stringify({ period: "2026-07", revenue_cents: 25000 }) }), env as never, execCtx);

    const getRes = await spacesWorker.fetch(req("/spaces/space-1/revenue-tracking?period=2026-07", h), env as never, execCtx);
    expect(await getRes.json()).toMatchObject({ revenue_cents: 25000 });
  });

  it("periods are isolated per (space, period, provider) — a different space never sees another's revenue", async () => {
    const env = makeEnv();
    const h1 = await headers("tenant-1");
    await spacesWorker.fetch(req("/spaces/space-1/revenue-tracking", h1, { method: "POST", body: JSON.stringify({ period: "2026-07", revenue_cents: 99999 }) }), env as never, execCtx);

    const h2 = await headers("tenant-2");
    const getRes = await spacesWorker.fetch(req("/spaces/space-2/revenue-tracking?period=2026-07", h2), env as never, execCtx);
    expect(await getRes.json()).toMatchObject({ revenue_cents: 0, billed: false });
  });

  it("GET with no period lists recent snapshots ordered newest-first, with last_tracked_at", async () => {
    const env = makeEnv();
    const h = await headers("tenant-1");
    await spacesWorker.fetch(req("/spaces/space-1/revenue-tracking", h, { method: "POST", body: JSON.stringify({ period: "2026-05", revenue_cents: 1000 }) }), env as never, execCtx);
    await spacesWorker.fetch(req("/spaces/space-1/revenue-tracking", h, { method: "POST", body: JSON.stringify({ period: "2026-06", revenue_cents: 2000 }) }), env as never, execCtx);
    await spacesWorker.fetch(req("/spaces/space-1/revenue-tracking", h, { method: "POST", body: JSON.stringify({ period: "2026-07", revenue_cents: 3000 }) }), env as never, execCtx);

    const getRes = await spacesWorker.fetch(req("/spaces/space-1/revenue-tracking", h), env as never, execCtx);
    const body = await getRes.json() as { snapshots: Array<{ period: string; revenue_cents: number }>; last_tracked_at: string | null };
    expect(body.snapshots.map((s) => s.period)).toEqual(["2026-07", "2026-06", "2026-05"]);
    expect(body.last_tracked_at).toBeTruthy();
  });

  it("rejects a malformed period", async () => {
    const env = makeEnv();
    const h = await headers("tenant-1");
    const res = await spacesWorker.fetch(
      req("/spaces/space-1/revenue-tracking", h, { method: "POST", body: JSON.stringify({ period: "July 2026", revenue_cents: 100 }) }),
      env as never, execCtx
    );
    expect(res.status).toBe(400);
  });
});
