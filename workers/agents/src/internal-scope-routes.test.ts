import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { app } from "./index.js";

const secret = "internal-scope-route-secret";

function env(active: boolean) {
  const concurrencyFetch = vi.fn(async () => Response.json({ claimed: true }));
  const concurrencyGet = vi.fn(() => ({ fetch: concurrencyFetch }));
  const concurrencyIdFromName = vi.fn((name: string) => name);
  const value = {
    PLATFORM_SECRET: secret,
    PLATFORM_DB: { prepare: () => ({ bind: (spaceId: string) => ({ first: async () => active && spaceId === "space-a" ? { id: "space-a" } : null }) }) },
    CONCURRENCY_DO: { idFromName: concurrencyIdFromName, get: concurrencyGet },
  } as never;
  return { value, concurrencyFetch, concurrencyGet, concurrencyIdFromName };
}

async function lease(binding: ReturnType<typeof env>, spaceId = "space-a") {
  return app.request("/internal/document-node-lease/claim", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-naelao-tenant-id": "tenant-a",
      "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a"),
    },
    body: JSON.stringify({
      tenant_id: "tenant-a", space_id: spaceId, project_id: "project-a", node_id: "src.index.ts",
      holder_id: "worker-a", holder_type: "AGENT",
    }),
  }, binding.value);
}

describe("internal document node lease scope", () => {
  it("does not open the lease Durable Object for a suspended Space or organization", async () => {
    const binding = env(false);
    const response = await lease(binding);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error_code: "tenant_suspended" });
    expect(binding.concurrencyIdFromName).not.toHaveBeenCalled();
    expect(binding.concurrencyGet).not.toHaveBeenCalled();
    expect(binding.concurrencyFetch).not.toHaveBeenCalled();
  });

  it("binds the requested Space to the signed tenant before touching lease state", async () => {
    const binding = env(true);
    const response = await lease(binding, "space-owned-by-other-tenant");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error_code: "tenant_suspended" });
    expect(binding.concurrencyGet).not.toHaveBeenCalled();
  });
});
