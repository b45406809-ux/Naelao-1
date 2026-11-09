import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { handleWorkspaceProjectCleanup } from "./workspace-project-cleanup.js";

const scope = { tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", jurisdiction: "global" as const };

function request(cursor?: string) {
  return mintInternalToken("platform-secret", scope.tenantId).then(token => new Request("http://agents/internal/workspaces/delete-project", {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": scope.tenantId, "x-naelao-internal-token": token },
    body: JSON.stringify({ scope, confirm: true, ...(cursor ? { cursor } : {}) }),
  }));
}

function fixture() {
  const objects = new Map([
    ["spaces/space-a/projects/project-a/workspace/branches/workers/worker-a/output.txt", "overlay"],
    ["spaces/space-a/projects/project-a/workspace/src/main.ts", "legacy"],
    ["spaces/space-a/provider-connections/shared", "tenant connection"],
  ]);
  const eraseCalls: unknown[] = [];
  const env = {
    PLATFORM_SECRET: "platform-secret",
    WORKSPACE_COORDINATOR: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async (value: Request) => { eraseCalls.push(await value.clone().json()); return Response.json({ erased: true }); } }),
    },
    SCRIPTS_R2: {
      async list({ prefix, cursor, limit = 1000 }: { prefix: string; cursor?: string; limit?: number }) {
        const after = cursor ? atob(cursor) : "";
        const matching = [...objects.keys()].filter(key => key.startsWith(prefix) && key > after).sort();
        const selected = matching.slice(0, Math.min(limit, 1));
        const truncated = matching.length > selected.length;
        return { objects: selected.map(key => ({ key })), truncated, ...(truncated ? { cursor: btoa(selected.at(-1)!) } : {}) };
      },
      async delete(keys: string[]) { for (const key of keys) objects.delete(key); },
    },
  };
  return { env: env as never, objects, eraseCalls };
}

describe("retryable project workspace cleanup", () => {
  it("erases coordinator state, pages legacy branch overlays, and preserves tenant provider connections", async () => {
    const { env, objects, eraseCalls } = fixture();
    const first = await handleWorkspaceProjectCleanup(await request(), env);
    expect(first.status).toBe(200);
    const firstResult = await first.json() as { erased: boolean; hasMore: boolean; nextCursor: string; providerConnectionsDeleted: boolean };
    expect(firstResult).toMatchObject({ erased: true, hasMore: true, providerConnectionsDeleted: false });

    const second = await handleWorkspaceProjectCleanup(await request(firstResult.nextCursor), env);
    expect(await second.json()).toMatchObject({ erased: true, hasMore: false, providerConnectionsDeleted: false });
    expect([...objects.keys()]).toEqual(["spaces/space-a/provider-connections/shared"]);
    expect(eraseCalls).toHaveLength(2);
  });

  it("returns a retryable error when legacy deletion fails and succeeds on replay", async () => {
    const { env, objects } = fixture();
    const bucket = (env as unknown as { SCRIPTS_R2: { delete(keys: string[]): Promise<void> } }).SCRIPTS_R2;
    const originalDelete = bucket.delete.bind(bucket);
    const remove = vi.fn(async (keys: string[]) => {
      if (remove.mock.calls.length === 1) throw new Error("temporary R2 failure");
      await originalDelete(keys);
    });
    bucket.delete = remove;

    const failed = await handleWorkspaceProjectCleanup(await request(), env);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ error_code: "workspace_cleanup_retryable_failure" });
    let cursor: string | undefined;
    for (let page = 0; page < 4; page++) {
      const replay = await handleWorkspaceProjectCleanup(await request(cursor), env);
      expect(replay.status).toBe(200);
      const result = await replay.json() as { hasMore: boolean; nextCursor?: string };
      if (!result.hasMore) break;
      cursor = result.nextCursor;
    }
    expect([...objects.keys()]).toEqual(["spaces/space-a/provider-connections/shared"]);
  });

  it("retries an erase whose first response was lost and preserves sibling provider connections", async () => {
    const { env, objects } = fixture();
    let tombstoned = false;
    let eraseAttempts = 0;
    (env as unknown as { WORKSPACE_COORDINATOR: { get: (id: string) => { fetch: (request: Request) => Promise<Response> } } }).WORKSPACE_COORDINATOR.get = () => ({
      fetch: async (value: Request) => {
        await value.json();
        eraseAttempts++;
        tombstoned = true; // the DO committed its tombstone before the Worker lost the response
        if (eraseAttempts === 1) throw new Error("simulated lost response after erase commit");
        return Response.json({ erased: true, scope });
      },
    });

    const lost = await handleWorkspaceProjectCleanup(await request(), env);
    expect(lost.status).toBe(503);
    expect(await lost.json()).toMatchObject({ error_code: "workspace_cleanup_retryable_failure" });
    expect(tombstoned).toBe(true);
    expect([...objects.keys()]).toContain("spaces/space-a/projects/project-a/workspace/src/main.ts");

    let cursor: string | undefined;
    for (let page = 0; page < 4; page++) {
      const replay = await handleWorkspaceProjectCleanup(await request(cursor), env);
      expect(replay.status).toBe(200);
      const result = await replay.json() as { erased: boolean; hasMore: boolean; nextCursor?: string; providerConnectionsDeleted: boolean };
      expect(result).toMatchObject({ erased: true, providerConnectionsDeleted: false });
      if (!result.hasMore) break;
      cursor = result.nextCursor;
    }
    expect(eraseAttempts).toBe(3);
    expect([...objects.keys()]).toEqual(["spaces/space-a/provider-connections/shared"]);
  });
});
