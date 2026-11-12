import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import worker from "./index.js";

const secret = "space-data-erasure-test-secret";

function harness(input: { claimed?: boolean } = {}) {
  let spaceDeleted = false;
  let doReplay = false;
  const doRequests: Request[] = [];
  const doStub = {
    fetch: vi.fn(async (request: Request) => {
      doRequests.push(request);
      const body = await request.clone().json() as { tenant_id: string; space_id: string; request_id: string };
      const replayed = doReplay;
      doReplay = true;
      return Response.json({ erased: true, ...body, replayed });
    }),
  };
  const prepare = vi.fn((sql: string) => ({
    bind: (..._values: unknown[]) => ({
      first: async () => {
        if (sql.includes("FROM gdpr_requests")) return input.claimed === false ? null : { id: "erase-request-a" };
        if (sql.includes("FROM orgs")) return { id: "tenant-a" };
        if (sql.includes("status='deleted' AND suspension_reason='erasure'")) return spaceDeleted ? { id: "space-a" } : null;
        return null;
      },
      run: async () => {
        if (sql.startsWith("UPDATE spaces SET status='deleted'")) {
          const changed = !spaceDeleted;
          spaceDeleted = true;
          return { success: true, meta: { changes: changed ? 1 : 0 } };
        }
        return { success: true, meta: { changes: 1 } };
      },
    }),
  }));
  return {
    env: {
      PLATFORM_SECRET: secret,
      PLATFORM_DB: { prepare },
      SPACE_DO: { idFromName: vi.fn(value => value), get: vi.fn(() => doStub) },
    } as never,
    doRequests,
    doStub,
    prepare,
  };
}

async function erasureRequest(requestId = "erase-request-a") {
  return new Request("https://spaces.test/internal/tenant/tenant-a/spaces/space-a/data-erasure", {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
      "x-naelao-tenant-id": "tenant-a",
      "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a"),
    },
    body: JSON.stringify({ request_id: requestId }),
  });
}

describe("whole-organization SpaceDO data erasure route", () => {
  it("requires a claimed erasure, fences the global Space row, and retries the exact DO receipt", async () => {
    const h = harness();
    const first = await worker.fetch(await erasureRequest(), h.env, { waitUntil: vi.fn() } as never);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ erased: true, tenant_id: "tenant-a", space_id: "space-a", request_id: "erase-request-a", replayed: false });
    expect(h.doRequests).toHaveLength(1);
    expect(new URL(h.doRequests[0]!.url).pathname).toBe("/internal/data-erasure");
    expect(h.doRequests[0]!.method).toBe("DELETE");
    expect(h.doRequests[0]!.headers.get("x-naelao-tenant-id")).toBe("tenant-a");
    expect(h.doRequests[0]!.headers.get("x-naelao-internal-token")).toBeTruthy();
    expect(await h.doRequests[0]!.clone().json()).toEqual({ tenant_id: "tenant-a", space_id: "space-a", request_id: "erase-request-a" });

    const retry = await worker.fetch(await erasureRequest(), h.env, { waitUntil: vi.fn() } as never);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ erased: true, replayed: true });
    expect(h.doRequests).toHaveLength(2);
  });

  it("does not touch the SpaceDO until the exact erasure request is claimed", async () => {
    const h = harness({ claimed: false });
    const response = await worker.fetch(await erasureRequest(), h.env, { waitUntil: vi.fn() } as never);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error_code: "erasure_request_not_claimed" });
    expect(h.doRequests).toHaveLength(0);
  });
});
