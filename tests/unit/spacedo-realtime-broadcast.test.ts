import { describe, it, expect } from "vitest";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { createDOStorage } from "./helpers/sqlite-do-shim.js";

// §A1.17 Phase V: confirms SpaceDO actually calls broadcastSpaceEvent (not just that the helper
// itself works, covered in packages/realtime-broadcast.test.ts) from every mutation point this
// pass wired: project created/updated, the exclusive-mode thread-lock transition, and presence
// heartbeats. Each fires only the RIGHT event/spaceId, and none of these mutations fail when
// WS_GATEWAY isn't bound (the default in every other SpaceDO test in this suite).

interface BroadcastCall { spaceId: string; event: string; data: unknown; tenantId: string }

function makeSpaceDO(): { doInstance: SpaceDO; calls: BroadcastCall[] } {
  const calls: BroadcastCall[] = [];
  const WS_GATEWAY = {
    async fetch(reqInput: Request | string, init?: RequestInit) {
      const req = typeof reqInput === "string" ? new Request(reqInput, init) : reqInput;
      const body = await req.clone().json() as { spaceId: string; event: string; data: unknown };
      calls.push({ ...body, tenantId: req.headers.get("x-naelao-tenant-id") ?? "" });
      return Response.json({ ok: true, sent: 1 });
    },
  };
  const ctx = { storage: createDOStorage() };
  const doInstance = new SpaceDO(ctx as never, { PLATFORM_SECRET: "test-secret", WS_GATEWAY } as never);
  return { doInstance, calls };
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

describe("SpaceDO real-time broadcasts (§A1.17 Phase V)", () => {
  it("createProject broadcasts project.created", async () => {
    const { doInstance, calls } = makeSpaceDO();
    await call(doInstance, "/projects", "POST", { space_id: "space-1", name: "New Project", tenant_id: "tenant-1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ spaceId: "space-1", event: "project.created", tenantId: "tenant-1" });
  });

  it("createProject does NOT re-fire project.created on an idempotent re-create", async () => {
    const { doInstance, calls } = makeSpaceDO();
    await call(doInstance, "/projects", "POST", { space_id: "space-1", name: "Same Name", tenant_id: "tenant-1" });
    await call(doInstance, "/projects", "POST", { space_id: "space-1", name: "Same Name", tenant_id: "tenant-1" });
    expect(calls.filter((c) => c.event === "project.created")).toHaveLength(1);
  });

  it("updateProject broadcasts project.updated with the tenant_id passed via query string", async () => {
    const { doInstance, calls } = makeSpaceDO();
    const created = await call(doInstance, "/projects", "POST", { space_id: "space-1", name: "P" });
    await call(doInstance, `/projects/${created.json.id}?tenant_id=tenant-1`, "PATCH", { description: "updated" });
    const updateEvents = calls.filter((c) => c.event === "project.updated");
    expect(updateEvents).toHaveLength(1);
    expect(updateEvents[0]).toMatchObject({ spaceId: "space-1", tenantId: "tenant-1" });
  });

  it("activateProjectThread broadcasts thread.activated only when exclusive_mode is on", async () => {
    const { doInstance, calls } = makeSpaceDO();
    const created = await call(doInstance, "/projects", "POST", { space_id: "space-1", name: "P" });

    // exclusive_mode off (default) — activation succeeds but does NOT broadcast.
    await call(doInstance, `/projects/${created.json.id}/activate-thread`, "POST", { thread_id: "t1", tenant_id: "tenant-1" });
    expect(calls.some((c) => c.event === "thread.activated")).toBe(false);

    // flip exclusive_mode on, then activate for real.
    await call(doInstance, `/projects/${created.json.id}?tenant_id=tenant-1`, "PATCH", { exclusive_mode: true });
    await call(doInstance, `/projects/${created.json.id}/activate-thread`, "POST", { thread_id: "t1", tenant_id: "tenant-1" });
    const activated = calls.filter((c) => c.event === "thread.activated");
    expect(activated).toHaveLength(1);
    expect(activated[0]).toMatchObject({ spaceId: "space-1", tenantId: "tenant-1" });
    expect(activated[0]!.data).toMatchObject({ project_id: created.json.id, thread_id: "t1" });
  });

  it("a blocked (409) activation does not broadcast", async () => {
    const { doInstance, calls } = makeSpaceDO();
    const created = await call(doInstance, "/projects", "POST", { space_id: "space-1", name: "P" });
    await call(doInstance, `/projects/${created.json.id}?tenant_id=tenant-1`, "PATCH", { exclusive_mode: true });
    await call(doInstance, `/projects/${created.json.id}/activate-thread`, "POST", { thread_id: "t1", tenant_id: "tenant-1" });
    calls.length = 0; // reset after the successful first activation
    const blocked = await call(doInstance, `/projects/${created.json.id}/activate-thread`, "POST", { thread_id: "t2", tenant_id: "tenant-1" });
    expect(blocked.status).toBe(409);
    expect(calls).toHaveLength(0);
  });

  it("heartbeatPresence broadcasts presence.heartbeat", async () => {
    const { doInstance, calls } = makeSpaceDO();
    await call(doInstance, "/presence", "POST", { space_id: "space-1", user_id: "alice", tenant_id: "tenant-1" });
    const presenceEvents = calls.filter((c) => c.event === "presence.update");
    expect(presenceEvents).toHaveLength(1);
    expect(presenceEvents[0]).toMatchObject({ spaceId: "space-1", tenantId: "tenant-1" });
    expect(presenceEvents[0]!.data).toMatchObject({ user_id: "alice" });
  });

  it("mutations succeed normally (and never throw) when WS_GATEWAY is not bound at all", async () => {
    const ctx = { storage: createDOStorage() };
    const doInstance = new SpaceDO(ctx as never, { PLATFORM_SECRET: "test-secret" } as never);
    const created = await call(doInstance, "/projects", "POST", { space_id: "space-1", name: "No Gateway", tenant_id: "tenant-1" });
    expect(created.status).toBe(201);
  });
});
