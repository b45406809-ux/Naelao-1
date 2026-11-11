import { describe, expect, it, vi } from "vitest";
import { workspaceCoordinatorRequest, type WorkspaceCoordinatorBindings } from "./workspace-client.js";
import { workspaceErasureLedgerKey } from "./phase6-erasure.js";

const scope = { tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", jurisdiction: "global" as const };

function database(hasTombstone: () => boolean): D1Database {
  return {
    prepare: () => ({
      bind: () => ({ first: async () => hasTombstone() ? { erased: 1 } : null }),
    }),
  } as unknown as D1Database;
}

function bindings(fetch: (request: Request) => Promise<Response>, hasTombstone: () => boolean): WorkspaceCoordinatorBindings {
  return {
    PLATFORM_SECRET: "test-secret",
    PLATFORM_DB: database(hasTombstone),
    WORKSPACE_COORDINATOR: {
      idFromName: name => name,
      get: () => ({ fetch }),
    } as unknown as DurableObjectNamespace,
  };
}

describe("workspace erasure tombstone guard", () => {
  it("blocks replayed coordinator access after a restore and does not call the restored DO", async () => {
    const fetch = vi.fn(async () => Response.json({ entries: [{ path: "private.txt" }] }));
    const response = await workspaceCoordinatorRequest(bindings(fetch, () => true), scope, "/v1/read?branch=main", {});
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error_code: "workspace_erased" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("withholds an in-flight response when the erasure ledger commits during the request", async () => {
    let erased = false;
    let finish!: (response: Response) => void;
    const canceled = vi.fn();
    const pending = new Promise<Response>(resolve => { finish = resolve; });
    const request = workspaceCoordinatorRequest(bindings(() => pending, () => erased), scope, "/v1/read?branch=main", {});
    await Promise.resolve();
    erased = true;
    finish(new Response(new ReadableStream({ cancel: canceled, start(controller) { controller.enqueue(new TextEncoder().encode("private")); } }), { status: 200 }));
    const response = await request;
    expect(response.status).toBe(410);
    expect(canceled).toHaveBeenCalled();
  });

  it("keeps the idempotent erase path available after the tombstone is recorded", async () => {
    const fetch = vi.fn(async () => Response.json({ erased: true }));
    const response = await workspaceCoordinatorRequest(bindings(fetch, () => true), scope, "/v1/erase", { body: { scope, confirm: true } });
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("replays an immutable R2 erasure ledger after D1 was restored to a pre-erasure backup", async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${scope.tenantId}\0${scope.spaceId}\0${scope.projectId}`));
    const tombstoneId = `wser_${[...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("")}`;
    let row = false;
    const db = {
      prepare(sql: string) {
        let values: unknown[] = [];
        const statement = {
          bind(...next: unknown[]) { values = next; return statement; },
          async first() {
            if (sql.includes("SELECT tombstone_id")) return row ? { tombstone_id: values[2] === scope.projectId ? tombstoneId : "", jurisdiction: scope.jurisdiction } : null;
            return row ? { erased: 1 } : null;
          },
          async run() { if (sql.includes("INSERT OR IGNORE INTO workspace_erasure_tombstones")) row = true; return { meta: { changes: 1 } }; },
        };
        return statement;
      },
    } as unknown as D1Database;
    const r2 = {
      async get(key: string) {
        if (key !== workspaceErasureLedgerKey(scope)) return null;
        return { async json() { return { tenant_id: scope.tenantId, space_id: scope.spaceId, project_id: scope.projectId,
          jurisdiction: scope.jurisdiction, tombstone_id: tombstoneId, requested_at: "2026-11-09T00:00:00.000Z" }; } };
      },
    } as unknown as R2Bucket;
    const fetch = vi.fn(async () => Response.json({ entries: [] }));
    const replayed = bindings(fetch, () => false);
    replayed.PLATFORM_DB = db;
    replayed.SCRIPTS_R2 = r2;
    const response = await workspaceCoordinatorRequest(replayed, scope, "/v1/read?branch=main", {});
    expect(response.status).toBe(410);
    expect(row).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});
