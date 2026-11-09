import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { app } from "./index.js";

describe("per-project workspace cleanup route", () => {
  it("holds the project mutation lease while tombstoning and deleting one retryable prefix page", async () => {
    const secret = "project-cleanup-route-secret";
    const lockEvents: Array<{ path: string; body: Record<string, unknown> }> = [];
    const coordinatorRequests: Array<{ path: string; body: unknown }> = [];
    const keys = new Set(["spaces/space-a/projects/project-a/workspace/branches/worker-a/file.txt"]);
    const concurrency = { fetch: vi.fn(async (request: Request) => {
      const body = await request.json() as Record<string, unknown>;
      const path = new URL(request.url).pathname;
      lockEvents.push({ path, body });
      return path.endsWith("/acquire") ? Response.json({ acquired: true, fencingToken: 7 }) : Response.json({ ok: true });
    }) };
    const bucket = {
      list: vi.fn(async ({ prefix, cursor, limit = 1000 }: { prefix: string; cursor?: string; limit?: number }) => {
        const after = cursor ? atob(cursor) : "";
        const selected = [...keys].filter(key => key.startsWith(prefix) && key > after).sort().slice(0, limit);
        const truncated = [...keys].some(key => key.startsWith(prefix) && key > (selected.at(-1) ?? after));
        return { objects: selected.map(key => ({ key })), truncated, ...(truncated && selected.length ? { cursor: btoa(selected.at(-1)!) } : {}) };
      }),
      delete: vi.fn(async (items: string | string[]) => { for (const key of Array.isArray(items) ? items : [items]) keys.delete(key); }),
    };
    const workspaceCoordinator = { fetch: vi.fn(async (request: Request) => {
      coordinatorRequests.push({ path: new URL(request.url).pathname, body: await request.json() });
      return Response.json({ erased: true });
    }) };
    const env = {
      PLATFORM_SECRET: secret,
      CONCURRENCY_DO: { idFromName: vi.fn((name: string) => name), get: vi.fn(() => concurrency) },
      WORKSPACE_COORDINATOR: { idFromName: vi.fn((name: string) => name), get: vi.fn(() => workspaceCoordinator) },
      SCRIPTS_R2: bucket,
    } as never;
    const token = await mintInternalToken(secret, "tenant-a");
    const response = await app.request("/internal/workspaces/delete-project", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token },
      body: JSON.stringify({ scope: { tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", jurisdiction: "global" }, confirm: true }),
    }, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ erased: true, hasMore: false, providerConnectionsDeleted: false });
    expect(lockEvents.map(event => event.path)).toEqual(["/locks/acquire", "/locks/release"]);
    expect(lockEvents[0]!.body).toMatchObject({ key: "lock:space-a:project-a:workspace-migration-barrier", ttlMs: 600_000 });
    expect(coordinatorRequests).toEqual([{ path: "/v1/erase", body: { scope: { tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", jurisdiction: "global" }, confirm: true } }]);
    expect(bucket.delete).toHaveBeenCalledWith(["spaces/space-a/projects/project-a/workspace/branches/worker-a/file.txt"]);
    expect([...keys]).toEqual([]);
  });

  it("fails closed when the project mutation lease is already held", async () => {
    const secret = "project-cleanup-route-secret";
    const concurrency = { fetch: vi.fn(async () => Response.json({ acquired: false })) };
    const workspaceCoordinator = { fetch: vi.fn() };
    const bucket = { list: vi.fn(), delete: vi.fn() };
    const env = { PLATFORM_SECRET: secret, CONCURRENCY_DO: { idFromName: () => "barrier", get: () => concurrency },
      WORKSPACE_COORDINATOR: { idFromName: () => "workspace", get: () => workspaceCoordinator }, SCRIPTS_R2: bucket } as never;
    const response = await app.request("/internal/workspaces/delete-project", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a",
        "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") },
      body: JSON.stringify({ scope: { tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", jurisdiction: "global" }, confirm: true }),
    }, env);
    expect(response.status).toBe(423);
    expect(await response.json()).toMatchObject({ error_code: "workspace_migration_barrier_busy" });
    expect(workspaceCoordinator.fetch).not.toHaveBeenCalled();
    expect(bucket.list).not.toHaveBeenCalled();
  });
});
