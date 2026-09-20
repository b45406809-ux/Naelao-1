import { describe, expect, it } from "vitest";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { createDOStorage } from "./helpers/sqlite-do-shim.js";

function fixture() {
  const storage = createDOStorage();
  const instance = new SpaceDO({ storage } as never, { PLATFORM_SECRET: "test" } as never);
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await instance.fetch(new Request(`http://space-do${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    return { status: response.status, body: await response.json<any>() };
  };
  return { instance, storage, call };
}

const scope = { tenant_id: "tenant-1", space_id: "space-1" };

describe("SpaceDO task lease governance", () => {
  it("atomically selects one holder and makes a losing claimant a spectator", async () => {
    const { call, storage } = fixture();
    const project = await call("/projects", "POST", { space_id: scope.space_id, tenant_id: scope.tenant_id, name: "P", created_by: "alice" });
    const created = await call(`/projects/${project.body.id}/tasks`, "POST", { ...scope, actor_id: "alice", title: "Implement policy", intent_embedding: [0.1, 0.2], sponsor_id: "lead" });
    const won = await call(`/projects/${project.body.id}/tasks/${created.body.id}/claim`, "POST", { ...scope, actor_id: "agent-a" });
    expect(won.status).toBe(200);
    expect(won.body.lease_version).toBe(1);
    expect(won.body.lease_expires_at - Date.now()).toBeGreaterThan(14 * 60 * 1000);

    const lost = await call(`/projects/${project.body.id}/tasks/${created.body.id}/claim`, "POST", { ...scope, actor_id: "agent-b" });
    expect(lost.status).toBe(409);
    expect(lost.body.mode).toBe("spectator");
    const spectators = storage.sql.exec<{ actor_id: string }>("SELECT actor_id FROM task_spectators WHERE task_id = ?", created.body.id).toArray();
    expect(spectators).toEqual([{ actor_id: "agent-b" }]);
  });

  it("requires holder plus lease version for renewal/completion and preserves expired history", async () => {
    const { instance, storage, call } = fixture();
    const project = await call("/projects", "POST", { space_id: scope.space_id, tenant_id: scope.tenant_id, name: "P", created_by: "alice" });
    const created = await call(`/projects/${project.body.id}/tasks`, "POST", { ...scope, actor_id: "alice", title: "T" });
    await call(`/projects/${project.body.id}/tasks/${created.body.id}/claim`, "POST", { ...scope, actor_id: "agent-a" });
    expect((await call(`/projects/${project.body.id}/tasks/${created.body.id}/renew`, "POST", { ...scope, actor_id: "agent-b", expected_version: 1 })).status).toBe(409);
    const renewed = await call(`/projects/${project.body.id}/tasks/${created.body.id}/renew`, "POST", { ...scope, actor_id: "agent-a", expected_version: 1 });
    expect(renewed.body.lease_version).toBe(2);
    expect((await call(`/projects/${project.body.id}/tasks/${created.body.id}/complete`, "POST", { ...scope, actor_id: "agent-a", expected_version: 1 })).status).toBe(409);

    storage.sql.exec("UPDATE tasks SET lease_expires_at = ? WHERE id = ?", Date.now() - 1, created.body.id);
    await instance.alarm();
    const row = storage.sql.exec<{ state: string; holder_id: string | null; lease_version: number }>("SELECT state, holder_id, lease_version FROM tasks WHERE id = ?", created.body.id).toArray()[0]!;
    expect(row).toEqual({ state: "READY", holder_id: null, lease_version: 3 });
    expect(storage.sql.exec("SELECT id FROM task_lease_events WHERE task_id = ?", created.body.id).toArray()).toHaveLength(2);
  });
});
