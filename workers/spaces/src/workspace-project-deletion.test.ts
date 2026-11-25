import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import spacesWorker from "./index.js";

describe("project workspace deletion route", () => {
  it("returns bounded cleanup progress only to Space owners/admins and omits internal cursors", async () => {
    const secret = "project-workspace-delete-test-secret";
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const env = {
      ENVIRONMENT: "test", PLATFORM_SECRET: secret,
      PLATFORM_DB: {
        prepare: (sql: string) => {
          const statement: { sql: string; values: unknown[]; bind: (...args: unknown[]) => unknown;
            first: () => Promise<{ found: number }>; all: () => Promise<{ success: boolean; results: Array<Record<string, unknown>> }> } = {
            sql, values: [], bind: (...values: unknown[]) => { statement.values = values; return statement; },
            first: async () => ({ found: 1 }),
            all: async () => {
              queries.push({ sql, values: statement.values });
              if (sql.includes("FROM workspace_erasure_tombstones")) return { success: true, results: [{ project_id: "generated-a",
                status: "cleaning", cleanup_phase: "bridge", cleanup_page: 3, jurisdiction: "global", requested_at: "2026-11-15T00:00:00.000Z",
                updated_at: "2026-11-15T00:01:00.000Z", completed_at: null, cleanup_cursor: "secret-r2-cursor", tombstone_id: "internal-id" }] };
              return { success: true, results: [{ project_id: "generated-a", total: 2, deleted: 1, pending: 1, unresolved: 0 }] };
            },
          };
          return statement;
        },
      },
    } as never;
    const send = async (role: string) => spacesWorker.fetch(new Request("https://spaces.test/spaces/space-a/workspace-cleanup-status", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "owner-a",
        "x-naelao-role": role, "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") },
      body: JSON.stringify({ projectIds: ["generated-a", "generated-a"] }),
    }), env);

    const response = await send("owner");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [{ projectId: "generated-a", status: "cleaning", phase: "bridge", cleanupPage: 3,
      jurisdiction: "global", requestedAt: "2026-11-15T00:00:00.000Z", updatedAt: "2026-11-15T00:01:00.000Z",
      providerDeletion: { total: 2, deleted: 1, pending: 1, unresolved: 0 } }] });
    expect(queries).toHaveLength(2);
    expect(queries.every(query => query.values.slice(0, 2).join(",") === "tenant-a,space-a")).toBe(true);
    expect(queries[0]?.values).toEqual(["tenant-a", "space-a", "generated-a"]);

    const member = await send("member");
    expect(member.status).toBe(403);
    expect(queries).toHaveLength(2);
  });

  it("archives before scoped cleanup and forwards retry cursors without touching tenant connections", async () => {
    const secret = "project-workspace-delete-test-secret";
    const spaceCalls: Array<{ method: string; path: string }> = [];
    const order: string[] = [];
    const coordinationBatches: string[][] = [];
    const cleanupBodies: Array<Record<string, unknown>> = [];
    const spaceStub = { fetch: vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      spaceCalls.push({ method: request.method, path: url.pathname });
      order.push(`space:${request.method}`);
      if (request.method === "GET") return Response.json({ id: "project-a", status: "active" });
      return Response.json({ id: "project-a", status: "archived" });
    }) };
    const agentFetch = vi.fn(async (request: Request) => {
      order.push("agent:cleanup");
      cleanupBodies.push(await request.json() as Record<string, unknown>);
      return cleanupBodies.length === 1
        ? Response.json({ erased: true, hasMore: true, nextCursor: "opaque-page-1", providerConnectionsDeleted: false })
        : Response.json({ erased: true, hasMore: false, legacyObjectsDeleted: 1, providerConnectionsDeleted: false });
    });
    const env = {
      ENVIRONMENT: "test", PLATFORM_SECRET: secret,
      PLATFORM_DB: {
        prepare: (sql: string) => {
          const statement: { sql: string; bind: (...args: unknown[]) => unknown; first: () => Promise<{ found: number }> } = {
            sql, bind: () => statement, first: async () => ({ found: 1 }),
          };
          return statement;
        },
        batch: async (statements: Array<{ sql: string }>) => { order.push("coordination:retire"); coordinationBatches.push(statements.map(statement => statement.sql)); return statements.map(() => ({ meta: { changes: 1 } })); },
      },
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
    expect(spaceCalls.map(call => call.method)).toEqual(["GET", "PATCH", "POST"]);
    expect(spaceCalls[2]?.path).toBe("/internal/project-deletion-mark");
    expect(order.slice(0, 5)).toEqual(["space:GET", "space:PATCH", "space:POST", "coordination:retire", "agent:cleanup"]);
    expect(coordinationBatches[0]).toHaveLength(6);
    expect(coordinationBatches[0]?.[0]).toContain("request_id IN (SELECT id FROM space_blackboard_requests");
    expect(coordinationBatches[0]?.[1]).toContain("DELETE FROM space_blackboard_requests");
    expect(coordinationBatches[0]?.[2]).toContain("DELETE FROM space_blackboard_cards");
    expect(new URL(spaceStub.fetch.mock.calls[1]![0].url).searchParams.get("tenant_id")).toBe("tenant-a");
    expect(cleanupBodies[0]).toMatchObject({ scope: { tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", jurisdiction: "global" }, confirm: true });

    const retry = await send({ confirm: true, cursor: "opaque-page-1" });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ archived: true, hasMore: false, providerConnectionsDeleted: false });
    expect(cleanupBodies[1]).toMatchObject({ cursor: "opaque-page-1", confirm: true });
    expect(coordinationBatches).toHaveLength(2); // deletion retries repeat the idempotent retirement batch
  });

  it("leaves the project archived but stops workspace cleanup when coordination retirement fails", async () => {
    const secret = "project-workspace-delete-test-secret";
    const spaceMethods: string[] = [];
    const agentFetch = vi.fn();
    const env = {
      ENVIRONMENT: "test", PLATFORM_SECRET: secret,
      PLATFORM_DB: { prepare: () => {
        const statement: { bind: () => unknown; first: () => Promise<{ found: number }> } = { bind: () => statement, first: async () => ({ found: 1 }) };
        return statement;
      }, batch: async () => { throw new Error("d1_unavailable"); } },
      SPACE_DO: { idFromName: (name: string) => name as never, get: () => ({ fetch: async (request: Request) => {
        spaceMethods.push(request.method);
        return request.method === "GET" ? Response.json({ id: "project-a", status: "active" }) : Response.json({ id: "project-a", status: "archived" });
      } }) },
      AGENTS_WORKER: { fetch: agentFetch },
    } as never;
    const response = await spacesWorker.fetch(new Request("https://spaces.test/spaces/space-a/projects/project-a", {
      method: "DELETE", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "owner-a",
        "x-naelao-role": "owner", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") }, body: JSON.stringify({ confirm: true }),
    }), env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error_code: "project_coordination_cleanup_unavailable", archived: true, retryable: true });
    expect(spaceMethods).toEqual(["GET", "PATCH", "POST"]);
    expect(agentFetch).not.toHaveBeenCalled();
  });

  it("retires coordination when the ordinary project patch archives a project", async () => {
    const secret = "project-workspace-delete-test-secret";
    const batches: string[][] = [];
    const patchBodies: unknown[] = [];
    let failRetirement = false;
    const env = {
      ENVIRONMENT: "test", PLATFORM_SECRET: secret,
      PLATFORM_DB: {
        prepare: (sql: string) => {
          const statement: { sql: string; bind: () => unknown } = { sql, bind: () => statement };
          return statement;
        },
        batch: async (statements: Array<{ sql: string }>) => {
          batches.push(statements.map(statement => statement.sql));
          if (failRetirement) throw new Error("d1_unavailable");
          return statements.map(() => ({ meta: { changes: 1 } }));
        },
      },
      SPACE_DO: { idFromName: (name: string) => name as never, get: () => ({ fetch: async (request: Request) => {
        if (request.method === "PATCH") patchBodies.push(await request.json());
        return Response.json({ id: "project-a", status: "archived" });
      } }) },
    } as never;
    const patch = async (body: unknown) => spacesWorker.fetch(new Request("https://spaces.test/spaces/space-a/projects/project-a", {
      method: "PATCH", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "owner-a",
        "x-naelao-role": "owner", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") }, body: JSON.stringify(body),
    }), env);

    const active = await patch({ status: "active" });
    expect(active.status).toBe(200);
    expect(batches).toHaveLength(0);

    const archived = await patch({ status: "archived" });
    expect(archived.status).toBe(200);
    expect(patchBodies).toEqual([{ status: "active" }, { status: "archived" }]);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(6);

    failRetirement = true;
    const retryable = await patch({ status: "archived" });
    expect(retryable.status).toBe(503);
    expect(await retryable.json()).toMatchObject({ error_code: "project_coordination_cleanup_unavailable", archived: true, retryable: true });
    expect(batches).toHaveLength(2);
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
