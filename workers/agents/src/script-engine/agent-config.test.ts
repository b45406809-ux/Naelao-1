import { describe, expect, it, vi } from "vitest";
import { createRemoteAgentConfigLockGateway, writeAgentConfig } from "./agent-config.js";

function bucket() {
  const values = new Map<string, string>();
  return {
    values,
    head: async (key: string) => values.has(key) ? { etag: `etag:${key}`, customMetadata: { sha256: "" } } : null,
    get: async (key: string) => values.has(key) ? { text: async () => values.get(key)! } : null,
    put: async (key: string, body: string) => { values.set(key, body); return { etag: `etag:${key}` }; },
  } as unknown as R2Bucket;
}

const config = {
  agentsMd: "# Assistant",
  systemPrompt: "Answer clearly.",
  scripts: { prebuilt: ["conversation"], startup_observe: "conversation.observe" },
  skills: { skills: [] },
};

describe("agent configuration bundle locking", () => {
  it("scopes the provisioner adapter to the space and normalizes the lock response", async () => {
    const requests: Request[] = [];
    const fetcher = {
      fetch: vi.fn(async (request: Request) => {
        requests.push(request);
        if (request.url.endsWith("/acquire")) return Response.json({ acquired: true });
        return Response.json({ released: true });
      }),
    } as unknown as Fetcher;
    const gateway = createRemoteAgentConfigLockGateway(fetcher, { "x-naelao-internal-token": "signed" }, "space-1");
    await expect(gateway.acquire({ key: "agent-config:space-1:agent-1", holderId: "provision-1", limit: 1, ttlMs: 30_000 }))
      .resolves.toMatchObject({ granted: true, active: 1 });
    await gateway.release({ key: "agent-config:space-1:agent-1", holderId: "provision-1" });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toContain("/internal/agent-config-lock/acquire");
    expect(await requests[0]?.json()).toMatchObject({ space_id: "space-1", holderId: "provision-1" });
    expect(requests[0]?.headers.get("x-naelao-internal-token")).toBe("signed");
  });

  it("holds the 30-second named lock across the four-file bundle", async () => {
    const acquire = vi.fn(async () => ({ granted: true, active: 1 }));
    const release = vi.fn(async () => undefined);
    await writeAgentConfig(bucket(), "space-1", "agent-1", config, {
      holderId: "run-1",
      lockGateway: { acquire, release, status: async () => ({ active: 1 }) },
    });
    expect(acquire).toHaveBeenCalledWith({ key: "agent-config:space-1:agent-1", holderId: "run-1", limit: 1, ttlMs: 30_000 });
    expect(release).toHaveBeenCalledWith({ key: "agent-config:space-1:agent-1", holderId: "run-1" });
  });

  it("does not write when another run owns the bundle lock", async () => {
    const store = bucket();
    const acquire = vi.fn(async () => ({ granted: false, active: 1 }));
    await expect(writeAgentConfig(store, "space-1", "agent-1", config, {
      holderId: "run-2",
      lockGateway: { acquire, release: async () => undefined, status: async () => ({ active: 1 }) },
    })).rejects.toThrow("agent_config_lock_unavailable");
    expect(store.values.size).toBe(0);
  });
});
