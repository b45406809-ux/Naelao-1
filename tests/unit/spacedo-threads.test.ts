import { describe, it, expect, beforeEach } from "vitest";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { createDOStorage } from "./helpers/sqlite-do-shim.js";

// Thread hierarchy (migration v13) — sub-agent runs and channel sessions mirror in as
// ordinary subthreads (thread_kind + parent_thread_id), hidden from the default list unless
// the project opts in via show_sub_threads or the caller passes include_sub_threads=true.

function makeSpaceDO(): SpaceDO {
  const ctx = { storage: createDOStorage() };
  const env = { PLATFORM_SECRET: "test-secret" };
  return new SpaceDO(ctx as never, env as never);
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

describe("SpaceDO — threads (spec-canonical, sub-agent/channel subthreads)", () => {
  let spaceDO: SpaceDO;

  beforeEach(() => {
    spaceDO = makeSpaceDO();
  });

  it("creates a primary thread by default", async () => {
    const created = await call(spaceDO, "/threads", "POST", { space_id: "space1", title: "Hello" });
    expect(created.status).toBe(201);
    expect(created.json.thread_kind).toBe("primary");
    expect(created.json.parent_thread_id).toBeNull();
  });

  it("rejects an unknown thread_kind", async () => {
    const bad = await call(spaceDO, "/threads", "POST", { space_id: "space1", thread_kind: "evil" });
    expect(bad.status).toBe(400);
  });

  it("a sub_agent thread with parent_thread_id is hidden from the default list, visible with include_sub_threads", async () => {
    const parent = await call(spaceDO, "/threads", "POST", { space_id: "space1", title: "Parent" });
    await call(spaceDO, "/threads", "POST", {
      space_id: "space1",
      id: "sub-1",
      thread_kind: "sub_agent",
      parent_thread_id: parent.json.id,
      title: "Sub-agent run",
    });

    const defaultList = await call(spaceDO, "/threads?space_id=space1", "GET");
    expect(defaultList.json.count).toBe(1);
    expect(defaultList.json.data[0].id).toBe(parent.json.id);

    const fullList = await call(spaceDO, "/threads?space_id=space1&include_sub_threads=true", "GET");
    expect(fullList.json.count).toBe(2);
    const sub = fullList.json.data.find((t: any) => t.id === "sub-1");
    expect(sub.thread_kind).toBe("sub_agent");
    expect(sub.parent_thread_id).toBe(parent.json.id);
  });

  it("a project with show_sub_threads=1 reveals its subthreads without include_sub_threads", async () => {
    const project = await call(spaceDO, "/projects", "POST", { space_id: "space1", name: "Support Bot" });
    await call(spaceDO, `/projects/${project.json.id}`, "PATCH", { show_sub_threads: true });

    await call(spaceDO, "/threads", "POST", { space_id: "space1", project_id: project.json.id, title: "Primary" });
    await call(spaceDO, "/threads", "POST", {
      space_id: "space1",
      project_id: project.json.id,
      thread_kind: "channel",
      channel: "whatsapp",
      channel_session_id: "chsess-1",
      title: "whatsapp: +1555",
    });

    const list = await call(spaceDO, `/threads?space_id=space1&project_id=${project.json.id}`, "GET");
    expect(list.json.count).toBe(2);
  });

  it("mirroring the same channel_session_id twice is idempotent (no duplicate thread)", async () => {
    const first = await call(spaceDO, "/threads", "POST", {
      space_id: "space1",
      thread_kind: "channel",
      channel: "discord",
      channel_session_id: "chsess-dupe",
    });
    const second = await call(spaceDO, "/threads", "POST", {
      space_id: "space1",
      thread_kind: "channel",
      channel: "discord",
      channel_session_id: "chsess-dupe",
    });
    expect(first.json.id).toBe(second.json.id);

    const list = await call(spaceDO, "/threads?space_id=space1&include_sub_threads=true", "GET");
    expect(list.json.count).toBe(1);
  });

  it("GET /threads/:id fetches a single thread, 404s when missing", async () => {
    const created = await call(spaceDO, "/threads", "POST", { space_id: "space1", title: "Solo" });
    const got = await call(spaceDO, `/threads/${created.json.id}`, "GET");
    expect(got.status).toBe(200);
    expect(got.json.title).toBe("Solo");

    const missing = await call(spaceDO, "/threads/does-not-exist", "GET");
    expect(missing.status).toBe(404);
  });
});
