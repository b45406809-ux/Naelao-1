import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import worker from "./index.js";

const secret = "project-steward-suspension-secret";

function harness() {
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn(() => ({
      first: async () => sql.includes("s.status='active'") ? null : {
        name: "Space A", spacetype_id: "type-a", config_json: null,
      },
    })),
  }));
  const doFetch = vi.fn(async () => Response.json({ data: [] }));
  const get = vi.fn(() => ({ fetch: doFetch }));
  return {
    env: { PLATFORM_SECRET: secret, PLATFORM_DB: { prepare }, SPACE_DO: { idFromName: vi.fn(value => value), get } } as never,
    get,
    doFetch,
  };
}

async function request(path: string, method = "GET") {
  return new Request(`https://spaces.test${path}`, {
    method,
    headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") },
  });
}

describe("Project Steward scheduler suspension boundary", () => {
  it("blocks installation and summary requests before SpaceDO access for inactive tenants or Spaces", async () => {
    const h = harness();
    const summary = await worker.fetch(await request("/internal/spaces/space-a/project-steward/summary"), h.env, { waitUntil: vi.fn() } as never);
    const installation = await worker.fetch(await request("/internal/spaces/space-a/project-steward/installation", "POST"), h.env, { waitUntil: vi.fn() } as never);
    const ownerContact = await worker.fetch(await request("/internal/spaces/space-a/owner-contact"), h.env, { waitUntil: vi.fn() } as never);

    expect(summary.status).toBe(403);
    expect(await summary.json()).toEqual({ error_code: "tenant_suspended" });
    expect(installation.status).toBe(403);
    expect(await installation.json()).toEqual({ error_code: "tenant_suspended" });
    expect(ownerContact.status).toBe(404);
    expect(await ownerContact.json()).toEqual({ found: false });
    expect(h.get).not.toHaveBeenCalled();
    expect(h.doFetch).not.toHaveBeenCalled();
  });
});
