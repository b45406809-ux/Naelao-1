import { describe, expect, it } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { applyMigrations, type SqlStorage } from "@naelao/db";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { SpaceDO } from "./SpaceDO.js";
import worker from "../index.js";

describe("bounded Space Blackboard project discovery", () => {
  it("uses stable keyset pages and rechecks project ACLs after revocation", async () => {
    const storage = createDOStorage();
    applyMigrations(storage as unknown as { sql: SqlStorage; transactionSync<T>(closure: () => T): T },
      (await import("./SpaceDO.js")).SPACE_DO_MIGRATIONS);
    const space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: "blackboard-page-test" } as never);
    const now = new Date().toISOString();
    storage.sql.exec(`INSERT INTO spaces(id,parent_id,name,space_type,tenancy_mode,depth,status,settings,created_at)
      VALUES('root',NULL,'Root','launchpad','team',0,'active','{}',?),
            ('department','root','Department','launchpad','team',1,'active','{}',?)`, now, now);
    const addProject = (id: string, visibility: "public" | "private", subspaceId: string | null = null, status = "active") =>
      storage.sql.exec("INSERT INTO projects(id,space_id,subspace_id,name,visibility,status) VALUES(?,?,?,?,?,?)",
        id, "root", subspaceId, id, visibility, status);
    addProject("p-01", "public");
    addProject("p-02", "private");
    addProject("p-03", "private");
    addProject("p-04", "public");
    addProject("p-05", "private", "department");
    addProject("p-06", "private");
    addProject("p-07", "public", null, "archived");
    storage.sql.exec("INSERT INTO project_members(project_id,user_id,role) VALUES('p-02','viewer','viewer'),('p-03','viewer','viewer')");
    storage.sql.exec("INSERT INTO space_members(space_id,user_id,role) VALUES('root','viewer','member')");
    storage.sql.exec("INSERT INTO space_members(space_id,user_id,role) VALUES('department','viewer','admin')");

    const page = async (after = "") => {
      const query = new URLSearchParams({ space_id: "root", viewer_id: "viewer", after, limit: "2" });
      const response = await space.fetch(new Request(`http://space/projects/blackboard-visible-page?${query}`));
      expect(response.status).toBe(200);
      return response.json() as Promise<{ project_ids: string[]; next_cursor: string | null; truncated: boolean }>;
    };

    const first = await page();
    expect(first).toEqual({ project_ids: ["p-01", "p-02"], next_cursor: "p-02", truncated: true });
    storage.sql.exec("DELETE FROM project_members WHERE project_id='p-03' AND user_id='viewer'");
    const second = await page(first.next_cursor ?? "");
    expect(second).toEqual({ project_ids: ["p-04"], next_cursor: null, truncated: false });
    expect([...first.project_ids, ...second.project_ids]).not.toContain("p-03");
    expect([...first.project_ids, ...second.project_ids]).not.toContain("p-06");
    expect([...first.project_ids, ...second.project_ids]).not.toContain("p-05");
    expect([...first.project_ids, ...second.project_ids]).not.toContain("p-07");

    const outsiderPage = await space.fetch(new Request(
      "http://space/projects/blackboard-visible-page?space_id=root&viewer_id=outsider&limit=10"));
    expect(outsiderPage.status).toBe(200);
    await expect(outsiderPage.json()).resolves.toMatchObject({ project_ids: [], truncated: false });

    storage.sql.exec("INSERT INTO projects(id,space_id,subspace_id,name,visibility,status) VALUES(?,?,?,?,?,?)",
      "child-private", "department", null, "Child private", "private", "active");
    storage.sql.exec("INSERT INTO space_members(space_id,user_id,role) VALUES('root','parent-owner','owner')");
    const inheritedOwnerPage = await space.fetch(new Request(
      "http://space/projects/blackboard-visible-page?space_id=department&viewer_id=parent-owner&limit=10"));
    expect(inheritedOwnerPage.status).toBe(200);
    await expect(inheritedOwnerPage.json()).resolves.toMatchObject({ project_ids: ["child-private"], truncated: false });

    const queryPlan = storage.sql.exec<{ detail: string }>(`
      EXPLAIN QUERY PLAN SELECT p.id FROM projects p INDEXED BY idx_projects_space_id
        WHERE p.space_id=? AND p.id>?
        AND p.status!='archived' ORDER BY p.id LIMIT ?`, "root", "", 91).toArray();
    expect(queryPlan.some((row) => row.detail.includes("idx_projects_space_id"))).toBe(true);
  });

  it("rejects unbounded and identity-free listing requests", async () => {
    const space = new SpaceDO({ storage: createDOStorage() } as never, { PLATFORM_SECRET: "blackboard-page-test" } as never);
    const oversized = await space.fetch(new Request("http://space/projects/blackboard-visible-page?space_id=root&viewer_id=user&limit=91"));
    expect(oversized.status).toBe(400);
    const anonymous = await space.fetch(new Request("http://space/projects/blackboard-visible-page?space_id=root&limit=10"));
    expect(anonymous.status).toBe(400);
  });

  it("uses the bounded SpaceDO page route before reading shared card summaries", async () => {
    const secret = "blackboard-page-test";
    const spaceRequests: Request[] = [];
    let pagePayload: unknown = { project_ids: ["project-02"], next_cursor: "project-02", truncated: true };
    let cardReads = 0;
    const spaceStub = {
      fetch: async (request: Request) => {
        spaceRequests.push(request);
        return Response.json(pagePayload);
      },
    };
    const db = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          first: async () => sql.includes("FROM spaces") ? { id: "space-a" } : null,
          all: async () => {
            if (!sql.includes("FROM space_blackboard_cards")) return { results: [] };
            cardReads++;
            return { results: [{
              project_id: "project-02", summary: "Shared summary", capabilities_json: "[]",
              evidence_json: "[]", updated_at: "2026-11-12T00:00:00.000Z",
            }] };
          },
        }),
      }),
    };
    const env = {
      ENVIRONMENT: "test", PLATFORM_SECRET: secret, PLATFORM_DB: db,
      SPACE_DO: { idFromName: (id: string) => id, get: () => spaceStub },
    } as never;
    const token = await mintInternalToken(secret, "tenant-a");
    const response = await worker.fetch(new Request("https://spaces.test/internal/spaces/space-a/blackboard/cards?after=project-01", {
      headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "viewer-a", "x-naelao-role": "product_end_user",
        "x-naelao-internal-token": token },
    }), env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      next_cursor: "project-02", truncated: true,
      cards: [{ projectId: "project-02", summary: "Shared summary" }],
    });
    expect(spaceRequests).toHaveLength(1);
    expect(new URL(spaceRequests[0]!.url).pathname).toBe("/projects/blackboard-visible-page");
    expect(Object.fromEntries(new URL(spaceRequests[0]!.url).searchParams)).toEqual({
      space_id: "space-a", after: "project-01", limit: "90", viewer_id: "viewer-a",
    });

    pagePayload = { project_ids: ["project-02", "project-02"], next_cursor: "project-02", truncated: true };
    const invalidPage = await worker.fetch(new Request("https://spaces.test/internal/spaces/space-a/blackboard/cards", {
      headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "viewer-a", "x-naelao-role": "product_end_user",
        "x-naelao-internal-token": token },
    }), env, {} as ExecutionContext);
    expect(invalidPage.status).toBe(503);
    expect(cardReads).toBe(1);
  });
});
