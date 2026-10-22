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

describe("POST /spaces/:spaceId/revenue-tracking/mark-billed", () => {
  it("requires a verified internal token", async () => {
    const env = makeEnv();
    const res = await spacesWorker.fetch(
      new Request("https://spaces.naelao.com/spaces/space-1/revenue-tracking/mark-billed", {
        method: "POST", headers: { "x-naelao-tenant-id": "tenant-1" }, body: JSON.stringify({ periods: ["2026-07"] }),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(403);
  });

  it("marks specific periods billed without touching their revenue_cents", async () => {
    const env = makeEnv();
    const h = await headers("tenant-1");
    await spacesWorker.fetch(req("/spaces/space-1/revenue-tracking", h, { method: "POST", body: JSON.stringify({ period: "2026-07", revenue_cents: 5000 }) }), env as never, execCtx);
    await spacesWorker.fetch(req("/spaces/space-1/revenue-tracking", h, { method: "POST", body: JSON.stringify({ period: "2026-06", revenue_cents: 3000 }) }), env as never, execCtx);

    const markRes = await spacesWorker.fetch(
      req("/spaces/space-1/revenue-tracking/mark-billed", h, { method: "POST", body: JSON.stringify({ periods: ["2026-07", "2026-06"] }) }),
      env as never, execCtx
    );
    expect(markRes.status).toBe(200);

    const getRes = await spacesWorker.fetch(req("/spaces/space-1/revenue-tracking?period=2026-07", h), env as never, execCtx);
    expect(await getRes.json()).toMatchObject({ revenue_cents: 5000, billed: true });
  });

  it("only marks the periods listed, leaving others untouched", async () => {
    const env = makeEnv();
    const h = await headers("tenant-1");
    await spacesWorker.fetch(req("/spaces/space-1/revenue-tracking", h, { method: "POST", body: JSON.stringify({ period: "2026-07", revenue_cents: 1000 }) }), env as never, execCtx);
    await spacesWorker.fetch(req("/spaces/space-1/revenue-tracking", h, { method: "POST", body: JSON.stringify({ period: "2026-06", revenue_cents: 2000 }) }), env as never, execCtx);
    await spacesWorker.fetch(req("/spaces/space-1/revenue-tracking/mark-billed", h, { method: "POST", body: JSON.stringify({ periods: ["2026-07"] }) }), env as never, execCtx);

    const juneRes = await spacesWorker.fetch(req("/spaces/space-1/revenue-tracking?period=2026-06", h), env as never, execCtx);
    expect(await juneRes.json()).toMatchObject({ billed: false });
  });

  it("rejects an empty periods list", async () => {
    const env = makeEnv();
    const h = await headers("tenant-1");
    const res = await spacesWorker.fetch(req("/spaces/space-1/revenue-tracking/mark-billed", h, { method: "POST", body: JSON.stringify({ periods: [] }) }), env as never, execCtx);
    expect(res.status).toBe(400);
  });
});

describe("F-27/F-31: billed_cents delta accounting + pending guard (SpaceDO)", () => {
  async function track(env: ReturnType<typeof makeEnv>, period: string, revenue: number) {
    const h = await headers("t1");
    return spacesWorker.fetch(req("/spaces/s1/revenue-tracking", h, { method: "POST", body: JSON.stringify({ period, revenue_cents: revenue }) }), env as never, execCtx);
  }
  async function markBilled(env: ReturnType<typeof makeEnv>, periods: string[], charges?: number[]) {
    const h = await headers("t1");
    return spacesWorker.fetch(req("/spaces/s1/revenue-tracking/mark-billed", h, { method: "POST", body: JSON.stringify({ periods, charges }) }), env as never, execCtx);
  }
  async function read(env: ReturnType<typeof makeEnv>, period: string) {
    const h = await headers("t1");
    const res = await spacesWorker.fetch(req(`/spaces/s1/revenue-tracking?period=${period}`, h), env as never, execCtx);
    return res.json() as Promise<{ revenue_cents: number; billed: boolean; billed_cents: number; pending_checkout_at: string | null; pending_checkout_id: string | null }>;
  }

  it("F-27: mark-billed with charges ACCUMULATES billed_cents; a correction does NOT reset it", async () => {
    const env = makeEnv();
    await track(env, "2026-06", 100_000);
    await markBilled(env, ["2026-06"], [5000]); // 5% of 100k charged
    let row = await read(env, "2026-06");
    expect(row).toMatchObject({ billed: true, billed_cents: 5000 });

    // Correct revenue up to 120k — billed_cents must persist (not revert to 0).
    await track(env, "2026-06", 120_000);
    row = await read(env, "2026-06");
    expect(row.revenue_cents).toBe(120_000);
    expect(row.billed_cents).toBe(5000); // F-27: NOT reset — only the 1000 delta is billable next

    // Bill the 1000 delta → billed_cents accumulates to the full 6000.
    await markBilled(env, ["2026-06"], [1000]);
    row = await read(env, "2026-06");
    expect(row.billed_cents).toBe(6000);
  });

  it("F-27: a refund (unmark with charge) reverses exactly that charge", async () => {
    const env = makeEnv();
    await track(env, "2026-06", 100_000);
    await markBilled(env, ["2026-06"], [5000]);
    const h = await headers("t1");
    await spacesWorker.fetch(req("/spaces/s1/revenue-tracking/unmark-billed", h, { method: "POST", body: JSON.stringify({ periods: ["2026-06"], charges: [5000] }) }), env as never, execCtx);
    const row = await read(env, "2026-06");
    expect(row.billed_cents).toBe(0);
    expect(row.billed).toBe(false);
  });

  it("F-31: checkout-scoped pending claims serialize competing checkouts and clear on payment", async () => {
    const env = makeEnv();
    await track(env, "2026-06", 100_000);
    const h = await headers("t1");
    const claim = (checkout_id: string, path = "mark-pending") => spacesWorker.fetch(req(`/spaces/s1/revenue-tracking/${path}`, h, {
      method: "POST", body: JSON.stringify({ periods: ["2026-06"], checkout_id }),
    }), env as never, execCtx);
    expect((await claim("checkout-a")).status).toBe(200);
    expect((await claim("checkout-a")).status).toBe(200); // same ID retry is idempotent
    expect((await claim("checkout-b")).status).toBe(409); // concurrent checkout cannot claim
    let row = await read(env, "2026-06");
    expect(row.pending_checkout_at).toBeTruthy();
    expect(row.pending_checkout_id).toBe("checkout-a");
    await claim("checkout-b", "release-pending"); // another checkout cannot release the owner claim
    row = await read(env, "2026-06");
    expect(row.pending_checkout_id).toBe("checkout-a");
    await claim("checkout-a", "release-pending");
    row = await read(env, "2026-06");
    expect(row.pending_checkout_id).toBeNull();
    expect((await claim("checkout-b")).status).toBe(200);
    await markBilled(env, ["2026-06"], [5000]);
    row = await read(env, "2026-06");
    expect(row.pending_checkout_at).toBeNull();
    expect(row.pending_checkout_id).toBeNull();
  });
});
