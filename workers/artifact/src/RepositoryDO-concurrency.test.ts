import { describe, expect, it } from "vitest";
import { RepositoryDO } from "./RepositoryDO.js";

describe("RepositoryDO concurrent head compare-and-swap", () => {
  it("accepts exactly one of 64 commits against the same stale head", async () => {
    const durableState = new Map<string, unknown>();
    const objects = new Map<string, Uint8Array>();
    let inputGate = Promise.resolve();
    const ctx = {
      storage: {
        get: async (key: string) => durableState.get(key),
        put: async (key: string, value: unknown) => { durableState.set(key, value); },
        delete: async (key: string) => { durableState.delete(key); },
      },
      blockConcurrencyWhile: <T>(callback: () => Promise<T>) => {
        const operation = inputGate.then(callback, callback);
        inputGate = operation.then(() => undefined, () => undefined);
        return operation;
      },
    };
    const bucket = {
      head: async (key: string) => objects.has(key),
      put: async (key: string, value: Uint8Array) => { objects.set(key, value); },
      get: async (key: string) => {
        const value = objects.get(key);
        return value ? { arrayBuffer: async () => value.slice().buffer } : null;
      },
    };
    const repo = new RepositoryDO(ctx as never, { REPOSITORY_OBJECTS: bucket } as never);
    const headers = {
      "x-repository-scope": JSON.stringify({ tenantId: "tenant", spaceId: "space", projectId: "project" }),
    };
    const init = await repo.fetch(new Request("https://repo/init", { method: "POST", headers }));
    expect(init.status).toBe(200);

    const attempts = await Promise.all(Array.from({ length: 64 }, (_, index) =>
      repo.fetch(new Request("https://repo/commit", {
        method: "POST",
        headers,
        body: JSON.stringify({
          expected_head: null,
          message: `parallel writer ${index}`,
          metadata: {
            agent_role: "worker", user_goal: "concurrent commit check", task_id: `task-${index}`,
            rationale: `writer ${index}`, thread_id: "thread", tool_turn_id: `turn-${index}`,
          },
          changes: [{
            path: `parallel/${index}.txt`, content_base64: btoa(`writer-${index}`), expected_hash: null,
          }],
        }),
      })),
    ));
    const statuses = await Promise.all(attempts.map(response => response.status));
    expect(statuses.filter(status => status === 201)).toHaveLength(1);
    expect(statuses.filter(status => status === 409)).toHaveLength(63);

    const tree = await repo.fetch(new Request("https://repo/tree", { headers }));
    const paths = (await tree.json() as { data: Array<{ path: string }> }).data.map(entry => entry.path);
    expect(tree.status).toBe(200);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/^parallel\/\d+\.txt$/);
  });
});
