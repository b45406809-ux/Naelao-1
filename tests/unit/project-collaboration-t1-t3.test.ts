import { describe, it, expect } from "vitest";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { createDOStorage } from "./helpers/sqlite-do-shim.js";

// §A1.17 Phase T1 (project visibility + real membership ACL) and T3 (hybrid thread locking,
// hard half) — both implemented entirely inside SpaceDO. T2 (@mention per-thread-agent
// addressing) is covered separately in project-mention-dispatch.test.ts.

function makeSpaceDO(): SpaceDO {
  const ctx = { storage: createDOStorage() };
  return new SpaceDO(ctx as never, { PLATFORM_SECRET: "test-secret" } as never);
}

async function call(doInstance: SpaceDO, path: string, method: string, body?: unknown): Promise<{ status: number; json: any }> {
  const resp = await doInstance.fetch(
    new Request(`http://space-do${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  );
  const json = await resp.json().catch(() => null);
  return { status: resp.status, json };
}

describe("Project visibility + membership (§A1.17 Phase T1)", () => {
  it("a private project (the default) is only visible to its creator, not another space member", async () => {
    const doInstance = makeSpaceDO();
    await call(doInstance, "/projects", "POST", { space_id: "space-1", name: "Secret Plans", created_by: "alice" });

    const aliceView = await call(doInstance, "/projects?space_id=space-1&viewer_id=alice", "GET");
    expect(aliceView.json.data).toHaveLength(1);

    const bobView = await call(doInstance, "/projects?space_id=space-1&viewer_id=bob", "GET");
    expect(bobView.json.data).toHaveLength(0);
  });

  it("a public project is visible to every viewer", async () => {
    const doInstance = makeSpaceDO();
    await call(doInstance, "/projects", "POST", { space_id: "space-1", name: "Team Docs", visibility: "public", created_by: "alice" });

    const bobView = await call(doInstance, "/projects?space_id=space-1&viewer_id=bob", "GET");
    expect(bobView.json.data).toHaveLength(1);
  });

  it("with no viewer_id (legacy/internal callers), every project is returned regardless of visibility", async () => {
    const doInstance = makeSpaceDO();
    await call(doInstance, "/projects", "POST", { space_id: "space-1", name: "Private One", created_by: "alice" });
    const listed = await call(doInstance, "/projects?space_id=space-1", "GET");
    expect(listed.json.data).toHaveLength(1);
  });

  it("the space owner/admin can see a private project even without being a project_member", async () => {
    const doInstance = makeSpaceDO();
    // A call triggers ensureInit()'s migrations before we reach into the DO's own SQLite directly.
    await call(doInstance, "/projects", "POST", { space_id: "space-1", name: "Hidden", created_by: "alice" });

    // Register carol as the space's owner directly via space_members (mirrors what the members
    // route would do in production).
    const sql = (doInstance as unknown as { ctx: { storage: { sql: { exec: (q: string, ...p: unknown[]) => unknown } } } }).ctx.storage.sql;
    sql.exec("INSERT INTO space_members (space_id, user_id, role) VALUES (?, ?, 'owner')", "space-1", "carol");

    const carolView = await call(doInstance, "/projects?space_id=space-1&viewer_id=carol", "GET");
    expect(carolView.json.data).toHaveLength(1);
  });

  it("explicit project_members CRUD: add, list, and remove", async () => {
    const doInstance = makeSpaceDO();
    const created = await call(doInstance, "/projects", "POST", { space_id: "space-1", name: "Shared", created_by: "alice" });
    const projectId = created.json.id;

    const added = await call(doInstance, `/projects/${projectId}/members`, "POST", { user_id: "dave", role: "viewer" });
    expect(added.status).toBe(201);

    const listed = await call(doInstance, `/projects/${projectId}/members`, "GET");
    expect(listed.json.data.map((m: { user_id: string; role: string }) => `${m.user_id}:${m.role}`).sort()).toEqual(["alice:owner", "dave:viewer"]);

    // dave (now a member, even as viewer) can see the private project.
    const daveView = await call(doInstance, `/projects?space_id=space-1&viewer_id=dave`, "GET");
    expect(daveView.json.data).toHaveLength(1);

    const removed = await call(doInstance, `/projects/${projectId}/members/dave`, "DELETE");
    expect(removed.status).toBe(200);
    const daveViewAfter = await call(doInstance, `/projects?space_id=space-1&viewer_id=dave`, "GET");
    expect(daveViewAfter.json.data).toHaveLength(0);
  });

  it("rejects an unknown member role", async () => {
    const doInstance = makeSpaceDO();
    const created = await call(doInstance, "/projects", "POST", { space_id: "space-1", name: "P1" });
    const added = await call(doInstance, `/projects/${created.json.id}/members`, "POST", { user_id: "x", role: "superadmin" });
    expect(added.status).toBe(400);
  });

  it("a PATCH can flip visibility from private to public and back", async () => {
    const doInstance = makeSpaceDO();
    const created = await call(doInstance, "/projects", "POST", { space_id: "space-1", name: "Toggle", created_by: "alice" });
    await call(doInstance, `/projects/${created.json.id}`, "PATCH", { visibility: "public" });
    const bobView = await call(doInstance, "/projects?space_id=space-1&viewer_id=bob", "GET");
    expect(bobView.json.data).toHaveLength(1);

    await call(doInstance, `/projects/${created.json.id}`, "PATCH", { visibility: "private" });
    const bobViewAfter = await call(doInstance, "/projects?space_id=space-1&viewer_id=bob", "GET");
    expect(bobViewAfter.json.data).toHaveLength(0);
  });
});

describe("Hybrid thread locking — exclusive mode (§A1.17 Phase T3)", () => {
  it("with exclusive_mode off (default), activation always succeeds and never blocks a second thread", async () => {
    const doInstance = makeSpaceDO();
    const created = await call(doInstance, "/projects", "POST", { space_id: "space-1", name: "Loose" });
    const projectId = created.json.id;

    const first = await call(doInstance, `/projects/${projectId}/activate-thread`, "POST", { thread_id: "thread-a" });
    expect(first.json).toEqual({ exclusive_mode: false, activated: true, thread_id: "thread-a" });

    const second = await call(doInstance, `/projects/${projectId}/activate-thread`, "POST", { thread_id: "thread-b" });
    expect(second.status).toBe(200);
    expect(second.json.activated).toBe(true);
  });

  it("with exclusive_mode on, a second thread is rejected 409 while the first is active", async () => {
    const doInstance = makeSpaceDO();
    const created = await call(doInstance, "/projects", "POST", { space_id: "space-1", name: "Strict" });
    const projectId = created.json.id;
    await call(doInstance, `/projects/${projectId}`, "PATCH", { exclusive_mode: true });

    const first = await call(doInstance, `/projects/${projectId}/activate-thread`, "POST", { thread_id: "thread-a" });
    expect(first.json.activated).toBe(true);

    const second = await call(doInstance, `/projects/${projectId}/activate-thread`, "POST", { thread_id: "thread-b" });
    expect(second.status).toBe(409);
    expect(second.json.active_thread_id).toBe("thread-a");
  });

  it("re-activating the SAME already-active thread succeeds (not a conflict with itself)", async () => {
    const doInstance = makeSpaceDO();
    const created = await call(doInstance, "/projects", "POST", { space_id: "space-1", name: "Strict2" });
    const projectId = created.json.id;
    await call(doInstance, `/projects/${projectId}`, "PATCH", { exclusive_mode: true });
    await call(doInstance, `/projects/${projectId}/activate-thread`, "POST", { thread_id: "thread-a" });

    const again = await call(doInstance, `/projects/${projectId}/activate-thread`, "POST", { thread_id: "thread-a" });
    expect(again.status).toBe(200);
  });

  it("take_over explicitly reassigns the lock — never a permanent deadlock", async () => {
    const doInstance = makeSpaceDO();
    const created = await call(doInstance, "/projects", "POST", { space_id: "space-1", name: "Strict3" });
    const projectId = created.json.id;
    await call(doInstance, `/projects/${projectId}`, "PATCH", { exclusive_mode: true });
    await call(doInstance, `/projects/${projectId}/activate-thread`, "POST", { thread_id: "thread-a" });

    const takeover = await call(doInstance, `/projects/${projectId}/activate-thread`, "POST", { thread_id: "thread-b", take_over: true });
    expect(takeover.status).toBe(200);
    expect(takeover.json.thread_id).toBe("thread-b");

    // Now thread-a is locked out until it takes over back.
    const blocked = await call(doInstance, `/projects/${projectId}/activate-thread`, "POST", { thread_id: "thread-a" });
    expect(blocked.status).toBe(409);
  });

  it("rejects activation with no thread_id", async () => {
    const doInstance = makeSpaceDO();
    const created = await call(doInstance, "/projects", "POST", { space_id: "space-1", name: "P" });
    const res = await call(doInstance, `/projects/${created.json.id}/activate-thread`, "POST", {});
    expect(res.status).toBe(400);
  });

  it("returns not_found for an unknown project", async () => {
    const doInstance = makeSpaceDO();
    const res = await call(doInstance, `/projects/does-not-exist/activate-thread`, "POST", { thread_id: "t1" });
    expect(res.status).toBe(404);
  });
});
