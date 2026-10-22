import { describe, expect, it, vi } from "vitest";
import { rollbackSpace } from "./index.js";

describe("provision rollback cleanup isolation", () => {
  it("continues through independent stores when an earlier cleanup fails", async () => {
    const scheduledCleanup = vi.fn(async () => { throw new Error("D1 temporarily unavailable"); });
    const statusUpdate = vi.fn(async () => ({ meta: { changes: 1 } }));
    const prepare = vi.fn((sql: string) => ({ bind: () => ({
      run: sql.startsWith("DELETE FROM scheduled_jobs") ? scheduledCleanup : statusUpdate,
    }) }));
    const portalDelete = vi.fn(async () => { throw new Error("KV unavailable"); });
    const spaceCacheDelete = vi.fn(async () => undefined);
    const calls: Request[] = [];
    const spacesFetch = vi.fn(async (request: Request) => {
      calls.push(request);
      if (request.method === "GET") return Response.json({ data: [{ id: "space-a:agent-a" }] });
      return Response.json({ deleted: true });
    });
    const env = {
      PLATFORM_SECRET: "secret",
      PLATFORM_DB: { prepare },
      SCRIPTS_R2: { list: vi.fn(async () => { throw new Error("R2 unavailable"); }) },
      PORTAL_KV: { delete: portalDelete },
      SPACES_KV: { delete: spaceCacheDelete },
      SPACES_WORKER: { fetch: spacesFetch },
    } as never;

    await rollbackSpace("space-a", "tenant-a", "launchpad", ["r2_prefixes", "external_portal", "agents", "owner_member"], env, "user-a");

    expect(portalDelete).toHaveBeenCalledOnce();
    expect(scheduledCleanup).toHaveBeenCalledOnce();
    expect(calls.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      "GET /spaces/space-a/agent-definitions",
      "DELETE /spaces/space-a/agent-definitions/space-a%3Aagent-a",
      "DELETE /spaces/space-a/members/user-a",
    ]);
    expect(statusUpdate).toHaveBeenCalledOnce();
    expect(spaceCacheDelete).toHaveBeenCalledOnce();
  });
});
