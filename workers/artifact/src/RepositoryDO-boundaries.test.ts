import { describe, expect, it, vi } from "vitest";
import { RepositoryDO } from "./RepositoryDO.js";

describe("RepositoryDO direct request body limit", () => {
  it("rejects streamed bodies over 16 MiB before entering the serialized state gate", async () => {
    const blockConcurrencyWhile = vi.fn(
      async (callback: () => Promise<Response>) => callback()
    );
    const repository = new RepositoryDO(
      { blockConcurrencyWhile } as never,
      {} as never
    );
    const response = await repository.fetch(
      new Request("http://repository/commit", {
        method: "POST",
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
            controller.close();
          },
        }),
        duplex: "half",
      } as RequestInit)
    );
    expect(response.status).toBe(413);
    expect(blockConcurrencyWhile).not.toHaveBeenCalled();
  });

  it("bounds workspace reconciliation before reading an oversized R2 object", async () => {
    const storage = new Map<string, unknown>();
    const get = vi.fn(async () => null);
    const repository = new RepositoryDO(
      { storage: {
        get: async (key: string) => storage.get(key),
        put: async (key: string, value: unknown) => { storage.set(key, value); },
        delete: async (key: string) => { storage.delete(key); },
      } } as never,
      {
        REPOSITORY_OBJECTS: {} as R2Bucket,
        WORKSPACE_R2: {
          list: async () => ({
            objects: [{ key: "spaces/s/projects/p/workspace/large.bin", size: 8 * 1024 * 1024 + 1 }],
            truncated: false,
          }),
          get,
        } as unknown as R2Bucket,
      } as never,
    );
    const headers = { "x-repository-scope": JSON.stringify({ tenantId: "t", spaceId: "s", projectId: "p" }) };
    await repository.fetch(new Request("http://repository/init", { method: "POST", headers }));

    const response = await repository.fetch(new Request("http://repository/reconcile", { method: "POST", headers }));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("scan limit") });
    expect(get).not.toHaveBeenCalled();
  });

  it("stops paginated reconciliation after 1,000 workspace files", async () => {
    const storage = new Map<string, unknown>();
    const list = vi.fn(async (options?: { cursor?: string }) => options?.cursor
      ? { objects: [{ key: "spaces/s/projects/p/workspace/file-1001", size: 0 }], truncated: false }
      : { objects: Array.from({ length: 1_000 }, (_, index) => ({ key: `spaces/s/projects/p/workspace/file-${index}`, size: 0 })), truncated: true, cursor: "next" });
    const repository = new RepositoryDO(
      { storage: {
        get: async (key: string) => storage.get(key),
        put: async (key: string, value: unknown) => { storage.set(key, value); },
        delete: async (key: string) => { storage.delete(key); },
      } } as never,
      {
        REPOSITORY_OBJECTS: {} as R2Bucket,
        WORKSPACE_R2: { list, get: async () => null } as unknown as R2Bucket,
      } as never,
    );
    const headers = { "x-repository-scope": JSON.stringify({ tenantId: "t", spaceId: "s", projectId: "p" }) };
    await repository.fetch(new Request("http://repository/init", { method: "POST", headers }));

    const response = await repository.fetch(new Request("http://repository/reconcile", { method: "POST", headers }));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("1000-file") });
    expect(list).toHaveBeenCalledTimes(2);
  });
});
