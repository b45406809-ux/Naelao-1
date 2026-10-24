import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import worker from "./index.js";

const secret = "test-platform-secret";

function dbForMissingTenantSpace() {
  const first = vi.fn(async () => null);
  const prepare = vi.fn(() => ({ bind: () => ({ first, run: async () => ({ success: true }) }) }));
  return { db: { prepare }, prepare, first };
}

async function request(path: string, method: "GET" | "POST", tenant = "tenant-a", body?: unknown, db = dbForMissingTenantSpace()) {
  const headers = new Headers({
    "x-naelao-tenant-id": tenant,
    "x-naelao-internal-token": await mintInternalToken(secret, tenant),
  });
  if (body !== undefined) headers.set("content-type", "application/json");
  const response = await worker.fetch(new Request(`https://spaces.test${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), {
    PLATFORM_SECRET: secret,
    PLATFORM_DB: db.db,
    NAELAO_CONFIG_KV: { put: vi.fn() },
  } as never, { waitUntil: vi.fn() } as never);
  return { response, ...db };
}

describe("retired business-service API", () => {
  it("does not expose service creation or query another tenant's Space", async () => {
    const { response, prepare } = await request("/internal/business-services", "POST", "tenant-a", {
      space_id: "other-tenant-space", kind: "custom_domain", custom_domain: "store.example.com",
    });
    expect(response.status).toBe(404);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("does not expose service configuration reads", async () => {
    const { response, prepare } = await request("/internal/business-services?space_id=other-tenant-space&kind=storefront", "GET");
    expect(response.status).toBe(404);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("does not expose custom-domain polling", async () => {
    const { response, prepare } = await request("/internal/business-services/custom-domain-status?space_id=other-tenant-space", "GET");
    expect(response.status).toBe(404);
    expect(prepare).not.toHaveBeenCalled();
  });
});
