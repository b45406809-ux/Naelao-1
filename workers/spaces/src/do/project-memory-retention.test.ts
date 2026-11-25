import { describe, expect, it, vi } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import spacesWorker from "../index.js";
import { mintInternalToken } from "@naelao/http";
import { SpaceDO } from "./SpaceDO.js";

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

async function setup(flag?: string) {
  const storage = createDOStorage();
  const space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: "retention-test", ...(flag ? { PROJECT_MEMORY_RETENTION_ENABLED: flag } : {}) } as never);
  await space.fetch(new Request("http://space/"));
  storage.sql.exec("INSERT INTO spaces(id,name,space_type,depth) VALUES('space','Test','business',0)");
  const addProject = (id: string, status = "archived", deletedAt?: string) => {
    storage.sql.exec("INSERT INTO projects(id,space_id,name,status) VALUES(?,?,?,?)", id, "space", id, status);
    storage.sql.exec("INSERT INTO project_facts(id,project_id,entity,relation,attribute,created_at,updated_at) VALUES(?,?,?,?,?,'x','x')", `f-${id}`, id, "e", "r", "a");
    storage.sql.exec("INSERT INTO project_fabric(id,project_id,session_id,summary,key_insights,created_at) VALUES(?,?,?,?,?,'x')", `b-${id}`, id, "s", "sum", "[]");
    storage.sql.exec("INSERT INTO project_wiki(project_id,concept,definition,relationships,updated_at) VALUES(?,?,?,?,'x')", id, "c", "d", "[]");
    if (deletedAt) storage.sql.exec("INSERT INTO project_deletion_tombstones(project_id,deleted_at) VALUES(?,?)", id, deletedAt);
  };
  const count = (id: string) => (["project_facts", "project_fabric", "project_wiki"] as const)
    .reduce((n, t) => n + (storage.sql.exec(`SELECT COUNT(*) AS n FROM ${t} WHERE project_id=?`, id).toArray()[0] as { n: number }).n, 0);
  return { storage, space, addProject, count };
}

describe("project memory retention", () => {
  it("removes memory of a Project deleted 31 days ago and keeps 29-day and live Projects", async () => {
    const { space, addProject, count, storage } = await setup("true");
    addProject("old", "archived", daysAgo(31));
    addProject("recent", "archived", daysAgo(29));
    addProject("live", "active");
    addProject("archived-not-deleted", "archived");
    await space.alarm();
    expect(count("old")).toBe(0);
    expect(count("recent")).toBe(3);
    expect(count("live")).toBe(3);
    expect(count("archived-not-deleted")).toBe(3);
    expect(storage.sql.exec("SELECT memory_purged_at FROM project_deletion_tombstones WHERE project_id='old'").toArray()[0]).not.toEqual({ memory_purged_at: null });
    await space.alarm(); // idempotent
    expect(count("recent")).toBe(3);
  });

  it("never deletes a live Project even with an old tombstone", async () => {
    const { space, addProject, count } = await setup("true");
    addProject("live", "active", daysAgo(90));
    await space.alarm();
    expect(count("live")).toBe(3);
  });

  it("reopening a deleted Project cancels its purge, so a later plain archive keeps memory", async () => {
    const { space, addProject, count, storage } = await setup("true");
    addProject("reopened", "archived", daysAgo(60));
    const patch = (status: string) => space.fetch(new Request("http://space/projects/reopened?tenant_id=t", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }) }));
    expect((await patch("active")).status).toBe(200);
    expect(storage.sql.exec("SELECT COUNT(*) AS n FROM project_deletion_tombstones WHERE project_id='reopened'").toArray()[0]).toEqual({ n: 0 });
    expect((await patch("archived")).status).toBe(200);
    await space.alarm();
    expect(count("reopened")).toBe(3);
  });

  it("flag off (unset or not exactly true) removes nothing", async () => {
    for (const flag of [undefined, "false", "TRUE", "1"]) {
      const { space, addProject, count } = await setup(flag);
      addProject("old", "archived", daysAgo(60));
      await space.alarm();
      expect(count("old")).toBe(3);
    }
  });

  it("an unexpired hold blocks, an expired hold does not, and clearing releases", async () => {
    const { space, addProject, count, storage } = await setup("true");
    addProject("held", "archived", daysAgo(60));
    addProject("expired", "archived", daysAgo(60));
    storage.sql.exec("INSERT INTO project_memory_holds(project_id,reason,actor_id,created_at,expires_at) VALUES('held','legal','u',?,?),('expired','legal','u',?,?)",
      daysAgo(5), new Date(Date.now() + DAY).toISOString(), daysAgo(5), daysAgo(1));
    await space.alarm();
    expect(count("held")).toBe(3);
    expect(count("expired")).toBe(0);
    expect((await space.fetch(new Request("http://space/project-memory-hold?project_id=held", { method: "DELETE" }))).status).toBe(200);
    await space.alarm();
    expect(count("held")).toBe(0);
  });

  it("is bounded per pass and re-arms until done", async () => {
    const { space, addProject, count, storage } = await setup("true");
    for (let i = 0; i < 7; i++) addProject(`p${i}`, "archived", daysAgo(40 + i));
    await space.alarm();
    const remaining = [0, 1, 2, 3, 4, 5, 6].filter(i => count(`p${i}`) > 0).length;
    expect(remaining).toBe(2);
    expect(await storage.getAlarm()).not.toBeNull();
    await space.alarm();
    expect([0, 1, 2, 3, 4, 5, 6].filter(i => count(`p${i}`) > 0).length).toBe(0);
  });

  it("sets, reads and clears a hold through the DO route and validates input", async () => {
    const { space, addProject } = await setup("true");
    addProject("p", "archived");
    const put = (body: unknown, id = "p") => space.fetch(new Request(`http://space/project-memory-hold?project_id=${id}&actor_id=admin-1`, { method: "PUT", body: JSON.stringify(body) }));
    expect((await put({ reason: "audit" })).status).toBe(200);
    const got = await (await space.fetch(new Request("http://space/project-memory-hold?project_id=p"))).json() as { hold: { reason: string; actor_id: string } };
    expect(got.hold).toMatchObject({ reason: "audit", actor_id: "admin-1" });
    expect((await put({ reason: "" })).status).toBe(400);
    expect((await put({ reason: "x", expires_at: "2000-01-01T00:00:00Z" })).status).toBe(400);
    expect((await put({ reason: "x" }, "missing")).status).toBe(404);
  });

  it("marking deletion keeps the first timestamp and arms the alarm", async () => {
    const { space, addProject, storage } = await setup("true");
    addProject("p", "archived");
    expect((await space.fetch(new Request("http://space/internal/project-deletion-mark?project_id=p", { method: "POST" }))).status).toBe(200);
    const first = storage.sql.exec("SELECT deleted_at FROM project_deletion_tombstones WHERE project_id='p'").toArray();
    await space.fetch(new Request("http://space/internal/project-deletion-mark?project_id=p", { method: "POST" }));
    expect(storage.sql.exec("SELECT deleted_at FROM project_deletion_tombstones WHERE project_id='p'").toArray()).toEqual(first);
    expect(await storage.getAlarm()).toBeGreaterThan(Date.now() + 29 * DAY);
  });
});

describe("project memory hold route", () => {
  const secret = "retention-route-secret";
  const build = () => {
    const calls: string[] = [];
    const stub = { fetch: vi.fn(async (r: Request) => { calls.push(`${r.method} ${new URL(r.url).pathname}${new URL(r.url).search}`); return Response.json({ hold: null }); }) };
    const env = { ENVIRONMENT: "test", PLATFORM_SECRET: secret,
      PLATFORM_DB: { prepare: () => { const s: { bind: () => unknown; first: () => Promise<unknown> } = { bind: () => s, first: async () => ({ found: 1, role: "member" }) }; return s; } },
      SPACE_DO: { idFromName: (n: string) => n as never, get: () => stub } } as never;
    return { calls, env };
  };
  const send = async (env: never, role: string, method = "GET", query = "project_id=p1") => spacesWorker.fetch(new Request(`https://spaces.test/spaces/space-a/project-memory-hold?${query}`, {
    method, headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "u1", "x-naelao-role": role,
      "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") },
    ...(method === "PUT" ? { body: JSON.stringify({ reason: "audit" }) } : {}) }), env);

  it("forwards for owner and admin", async () => {
    const { calls, env } = build();
    expect((await send(env, "owner", "PUT")).status).toBe(200);
    expect((await send(env, "admin", "DELETE")).status).toBe(200);
    expect(calls[0]).toContain("PUT /project-memory-hold?project_id=p1&actor_id=u1");
  });

  it("returns the not-found shape for non-admins and never reaches the Space", async () => {
    const { calls, env } = build();
    for (const role of ["member", "viewer", "product_end_user"]) {
      for (const method of ["GET", "PUT", "DELETE"]) expect((await send(env, role, method)).status).toBe(404);
    }
    expect(calls).toHaveLength(0);
  });
});
