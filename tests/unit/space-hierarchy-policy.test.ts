import { describe, expect, it } from "vitest";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { createSpaceRecord } from "../../workers/spaces/src/create-space.js";
import { createDOStorage } from "./helpers/sqlite-do-shim.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

function makeSpaceDO(): SpaceDO {
  return new SpaceDO({ storage: createDOStorage() } as never, { PLATFORM_SECRET: "test" } as never);
}

async function call(space: SpaceDO, path: string, method = "GET", body?: unknown) {
  const response = await space.fetch(new Request(`http://space-do${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { status: response.status, json: await response.json<any>() };
}

describe("Launchpad hierarchy policy", () => {
  it("allows parent administration downward without propagating department membership", async () => {
    const space = makeSpaceDO();
    expect((await call(space, "/spaces", "POST", { id: "root", name: "Root", space_type: "launchpad" })).status).toBe(201);
    await call(space, "/members", "POST", { space_id: "root", user_id: "root-admin", role: "admin" });
    await call(space, "/sub-spaces", "POST", { id: "sales", parent_id: "root", name: "Sales" });
    await call(space, "/sub-spaces", "POST", { id: "legal", parent_id: "root", name: "Legal" });
    await call(space, "/members", "POST", { space_id: "sales", user_id: "sales-admin", role: "admin" });

    expect((await call(space, "/hierarchy-authorize?user_id=root-admin&target_space_id=sales")).json.permitted).toBe(true);
    expect((await call(space, "/hierarchy-authorize?user_id=sales-admin&target_space_id=root")).json.permitted).toBe(false);
    expect((await call(space, "/hierarchy-authorize?user_id=sales-admin&target_space_id=legal")).json.permitted).toBe(false);
    expect((await call(space, "/members?space_id=root")).json.data.map((m: any) => m.user_id)).not.toContain("sales-admin");
    expect((await call(space, "/members?space_id=legal")).json.data).toEqual([]);
  });

  it("rejects malformed roots and grandchildren while retaining the default Launchpad product", async () => {
    const space = makeSpaceDO();
    expect((await call(space, "/spaces", "POST", { id: "bad", name: "Bad" })).status).toBe(400);
    expect((await call(space, "/spaces", "POST", { id: "bad-root", name: "Bad", space_type: "launchpad", parent_id: "x" })).status).toBe(400);
    await call(space, "/spaces", "POST", { id: "root", name: "Root", space_type: "launchpad" });
    await call(space, "/sub-spaces", "POST", { id: "dept", parent_id: "root", name: "Department" });
    expect((await call(space, "/sub-spaces", "POST", { parent_id: "dept", name: "Grandchild" })).status).toBe(400);
  });

  it("does not resolve a parent across a tenant boundary", async () => {
    const db = createFakeD1([`
      CREATE TABLE spaces (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, spacetype_id TEXT NOT NULL,
        name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', config_json TEXT NOT NULL DEFAULT '{}',
        product_slug TEXT, parent_space_id TEXT, depth INTEGER NOT NULL DEFAULT 0, created_at TEXT, updated_at TEXT, created_by TEXT);
      CREATE TABLE orgs (id TEXT PRIMARY KEY, plan_tier TEXT NOT NULL DEFAULT 'free');
      CREATE TABLE spacetypes (id TEXT PRIMARY KEY, schema_json TEXT);
    `]);
    db.db.exec("INSERT INTO spaces (id, tenant_id, spacetype_id, name, depth) VALUES ('foreign-root', 'tenant-b', 'launchpad', 'Foreign', 0)");
    await expect(createSpaceRecord({ PLATFORM_DB: db }, {
      tenantId: "tenant-a", name: "Intruder", spacetypeId: "launchpad", parentSpaceId: "foreign-root", depth: 1,
    })).rejects.toMatchObject({ status: 404, error_code: "parent_not_found" });
  });

  it("returns an indistinguishable 404 for missing and unauthorized confidential projects", async () => {
    const space = makeSpaceDO();
    await call(space, "/spaces", "POST", { id: "root", name: "Root", space_type: "launchpad" });
    await call(space, "/members", "POST", { space_id: "root", user_id: "owner", role: "owner" });
    await call(space, "/members", "POST", { space_id: "root", user_id: "outsider", role: "member" });
    const created = await call(space, "/projects", "POST", {
      space_id: "root",
      tenant_id: "tenant",
      name: "Acquisition",
      visibility: "private",
      created_by: "owner",
      system_caller: true,
    });
    expect(created.status).toBe(201);

    const denied = await call(space, `/projects/${created.json.id}?viewer_id=outsider`);
    const absent = await call(space, "/projects/does-not-exist?viewer_id=outsider");
    expect(denied).toEqual(absent);
    expect(denied).toEqual({
      status: 404,
      json: { error_code: "not_found", message: "Project not found" },
    });
    expect((await call(space, `/projects/${created.json.id}?viewer_id=owner`)).status).toBe(200);
  });
});
