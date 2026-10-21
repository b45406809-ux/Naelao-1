import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import worker from "./index.js";

const secret = "members-suspension-test-secret";

function harness(active: boolean) {
  const doFetch = vi.fn(async () => Response.json({ data: [{ user_id: "owner-a", role: "owner" }] }));
  const get = vi.fn(() => ({ fetch: doFetch }));
  return {
    env: {
      PLATFORM_SECRET: secret,
      PLATFORM_DB: { prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first: async () => active ? { id: "space-a" } : null })) })) },
      SPACE_DO: { idFromName: vi.fn(value => value), get },
    } as never,
    get,
    doFetch,
  };
}

async function request() {
  return new Request("https://spaces.test/spaces/space-a/members", {
    headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") },
  });
}

describe("Space member lookup suspension boundary", () => {
  it("blocks member lookups before SpaceDO access for inactive tenant or Space", async () => {
    const h = harness(false);
    const response = await worker.fetch(await request(), h.env, { waitUntil: vi.fn() } as never);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error_code: "tenant_suspended" });
    expect(h.get).not.toHaveBeenCalled();
  });

  it("forwards internal member lookups for an active tenant and Space", async () => {
    const h = harness(true);
    const response = await worker.fetch(await request(), h.env, { waitUntil: vi.fn() } as never);
    expect(response.status).toBe(200);
    expect(h.doFetch).toHaveBeenCalledOnce();
  });
});
