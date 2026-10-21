import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import worker from "./index.js";

const secret = "tunnel-suspension-test-secret";

function harness(active: boolean) {
  const first = vi.fn(async () => active ? { id: "space-a" } : null);
  const prepare = vi.fn(() => ({ bind: vi.fn(() => ({ first })) }));
  const fetch = vi.fn(async () => Response.json({ machine: { machineId: "machine-a" } }));
  const get = vi.fn(() => ({ fetch }));
  return {
    env: {
      PLATFORM_SECRET: secret,
      PLATFORM_DB: { prepare },
      SPACE_DO: { idFromName: vi.fn(value => value), get },
    } as never,
    prepare,
    get,
    fetch,
  };
}

async function call(env: unknown) {
  const token = await mintInternalToken(secret, "tenant-a");
  return worker.fetch(new Request("https://spaces.test/spaces/space-a/tunnel-authority", {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token },
    body: JSON.stringify({ action: "lookup", machineId: "machine-a" }),
  }), env as never, { waitUntil: vi.fn() } as never);
}

describe("internal local-machine authority tenant suspension boundary", () => {
  it("rejects machine authority lookups before reaching SpaceDO after suspension", async () => {
    const h = harness(false);
    const response = await call(h.env);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error_code: "tenant_suspended" });
    expect(h.prepare).toHaveBeenCalledOnce();
    expect(h.get).not.toHaveBeenCalled();
  });

  it("forwards authority lookups for an active tenant and Space", async () => {
    const h = harness(true);
    const response = await call(h.env);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ machine: { machineId: "machine-a" } });
    expect(h.get).toHaveBeenCalledOnce();
    expect(h.fetch).toHaveBeenCalledOnce();
  });
});
