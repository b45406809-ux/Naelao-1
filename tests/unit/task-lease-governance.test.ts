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

  it("joins semantically duplicated work and freezes contradictory sponsors before a lease", async () => {
    const { call } = fixture();
    const project = await call("/projects", "POST", { space_id: scope.space_id, tenant_id: scope.tenant_id, name: "P", created_by: "alice" });
    const first = await call(`/projects/${project.body.id}/tasks`, "POST", { ...scope, actor_id: "agent-a", sponsor_id: "lead-a", title: "Use Postgres", scope: { path: "db" }, intent_embedding: [1, 0] });
    const duplicate = await call(`/projects/${project.body.id}/tasks`, "POST", { ...scope, actor_id: "agent-b", sponsor_id: "lead-a", title: "Use Postgres", scope: { path: "db" }, intent_embedding: [0.99, 0.01] });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toMatchObject({ mode: "spectator", existing_task_id: first.body.id });

    const conflict = await call(`/projects/${project.body.id}/tasks`, "POST", { ...scope, actor_id: "agent-c", sponsor_id: "lead-b", title: "Remove Postgres", scope: { path: "db" }, intent_embedding: [0.98, 0.02] });
    expect(conflict.status).toBe(202);
    expect(conflict.body).toMatchObject({ state: "RFC_FROZEN", conflicting_task_id: first.body.id });
    expect((await call(`/projects/${project.body.id}/tasks/${first.body.id}/claim`, "POST", { ...scope, actor_id: "agent-a" })).body.error_code).toBe("task_not_claimable");
  });

  it("allows spectators to request review and terminates unresolved deliberation at round two for exactly one lead", async () => {
    const { call } = fixture();
    const project = await call("/projects", "POST", { space_id: scope.space_id, tenant_id: scope.tenant_id, name: "P", created_by: "alice" });
    const first = await call(`/projects/${project.body.id}/tasks`, "POST", { ...scope, actor_id: "agent-a", sponsor_id: "lead-a", title: "A", scope: { path: "x" }, intent_embedding: [1, 0] });
    await call(`/projects/${project.body.id}/tasks`, "POST", { ...scope, actor_id: "agent-b", sponsor_id: "lead-a", title: "A", scope: { path: "x" }, intent_embedding: [1, 0] });
    expect((await call(`/projects/${project.body.id}/tasks/${first.body.id}/request-review`, "POST", { ...scope, actor_id: "agent-b" })).status).toBe(200);

    await call(`/projects/${project.body.id}/tasks`, "POST", { ...scope, actor_id: "agent-c", sponsor_id: "lead-b", title: "Not A", scope: { path: "x" }, intent_embedding: [1, 0] });
    expect((await call(`/projects/${project.body.id}/tasks/${first.body.id}/deliberate`, "POST", { ...scope, actor_id: "alice" })).body.deliberation_round).toBe(1);
    const noOwner = await call(`/projects/${project.body.id}/tasks/${first.body.id}/deliberate`, "POST", { ...scope, actor_id: "alice" });
    expect(noOwner.status).toBe(503);
    await call(`/projects/${project.body.id}/alert-owner`, "PUT", { ...scope, actor_id: "alice", user_id: "alice" });
    const blocked = await call(`/projects/${project.body.id}/tasks/${first.body.id}/deliberate`, "POST", { ...scope, actor_id: "alice" });
    expect(blocked.body).toMatchObject({ state: "BLOCKED_AWAITING_HUMAN", deliberation_round: 2, designated_owner_id: "alice" });
  });
});
