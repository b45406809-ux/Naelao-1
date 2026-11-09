import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import spacesWorker from "./index.js";

describe("project workspace deletion route", () => {
  it("archives before scoped cleanup and forwards retry cursors without touching tenant connections", async () => {
    const secret = "project-workspace-delete-test-secret";
    const spaceCalls: Array<{ method: string; path: string }> = [];
    const cleanupBodies: Array<Record<string, unknown>> = [];
    const spaceStub = { fetch: vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      spaceCalls.push({ method: request.method, path: url.pathname });
      if (request.method === "GET") return Response.json({ id: "project-a", status: "active" });
      return Response.json({ id: "project-a", status: "archived" });
    }) };
    const agentFetch = vi.fn(async (request: Request) => {
      cleanupBodies.push(await request.json() as Record<string, unknown>);
      return cleanupBodies.length === 1
        ? Response.json({ erased: true, hasMore: true, nextCursor: "opaque-page-1", providerConnectionsDeleted: false })
        : Response.json({ erased: true, hasMore: false, legacyObjectsDeleted: 1, providerConnectionsDeleted: false });
    });
    const env = {
      ENVIRONMENT: "test", PLATFORM_SECRET: secret,
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ found: 1 }) }) }) },
      SPACE_DO: { idFromName: (name: string) => name as never, get: () => spaceStub },
      AGENTS_WORKER: { fetch: agentFetch },
    } as never;

    const send = async (body: unknown) => spacesWorker.fetch(new Request("https://spaces.test/spaces/space-a/projects/project-a", {
      method: "DELETE", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "owner-a",
        "x-naelao-role": "owner", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") }, body: JSON.stringify(body),
    }), env);

    const first = await send({ confirm: true });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ archived: true, hasMore: true, nextCursor: "opaque-page-1", providerConnectionsDeleted: false });
    expect(spaceCalls.map(call => call.method)).toEqual(["GET", "PATCH"]);
    expect(new URL(spaceStub.fetch.mock.calls[1]![0].url).searchParams.get("tenant_id")).toBe("tenant-a");
    expect(cleanupBodies[0]).toMatchObject({ scope: { tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", jurisdiction: "global" }, confirm: true });

    const retry = await send({ confirm: true, cursor: "opaque-page-1" });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ archived: true, hasMore: false, providerConnectionsDeleted: false });
    expect(cleanupBodies[1]).toMatchObject({ cursor: "opaque-page-1", confirm: true });
  });

  it("requires an explicit confirmation and space administrator", async () => {
    const secret = "project-workspace-delete-test-secret";
    const spaceFetch = vi.fn();
    const agentFetch = vi.fn();
    const env = {
      ENVIRONMENT: "test", PLATFORM_SECRET: secret,
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ found: 1 }) }) }) },
      SPACE_DO: { idFromName: (name: string) => name as never, get: () => ({ fetch: spaceFetch }) },
      AGENTS_WORKER: { fetch: agentFetch },
    } as never;
    const request = async (role: string, body: unknown) => spacesWorker.fetch(new Request("https://spaces.test/spaces/space-a/projects/project-a", {
      method: "DELETE", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "user-a",
        "x-naelao-role": role, "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") }, body: JSON.stringify(body),
    }), env);
    const denied = await request("owner", { confirm: false });
    expect(denied.status).toBe(400);
    expect(spaceFetch).not.toHaveBeenCalled();
    expect(agentFetch).not.toHaveBeenCalled();
  });
});
