import { describe, it, expect } from "vitest";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { createDOStorage, type DOSqlStorage } from "./helpers/sqlite-do-shim.js";

// Templates ship pre-wired projects bound to whichever installed agent owns that project's
// work (spec follow-up: "prebuilt projects, threads, agents ... that's what a template should
// have, all preconfigured, but can be changed"). projects.default_agent_id (migration v18) is
// the persisted binding; it's a DEFAULT only, never an enforced identity, so it must be
// settable at creation, readable via GET/list, and freely reassignable/clearable via PATCH.

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

describe("SpaceDO projects — default_agent_id (template-seeded agent binding)", () => {
  it("persists default_agent_id set at creation and returns it via GET", async () => {
    const doInstance = makeSpaceDO();
    const created = await call(doInstance, "/projects", "POST", {
      space_id: "space1", name: "Orders", default_agent_id: "launchpad-fulfillment-v1",
    });
    expect(created.status).toBe(201);
    expect(created.json.default_agent_id).toBe("launchpad-fulfillment-v1");

    const got = await call(doInstance, `/projects/${created.json.id}`, "GET");
    expect(got.status).toBe(200);
    expect(got.json.default_agent_id).toBe("launchpad-fulfillment-v1");
  });

  it("a project created with no default_agent_id has a null binding (reference/data project)", async () => {
    const doInstance = makeSpaceDO();
    const created = await call(doInstance, "/projects", "POST", { space_id: "space1", name: "Products" });
    expect(created.json.default_agent_id).toBeNull();
  });

  it("listProjects includes default_agent_id for every row", async () => {
    const doInstance = makeSpaceDO();
    await call(doInstance, "/projects", "POST", { space_id: "space1", name: "Products" });
    await call(doInstance, "/projects", "POST", { space_id: "space1", name: "Orders", default_agent_id: "launchpad-fulfillment-v1" });

    const list = await call(doInstance, "/projects?space_id=space1", "GET");
    expect(list.status).toBe(200);
    const byName = Object.fromEntries(list.json.data.map((p: any) => [p.name, p.default_agent_id]));
    expect(byName["Products"]).toBeNull();
    expect(byName["Orders"]).toBe("launchpad-fulfillment-v1");
  });

  it("PATCH can reassign a project's default_agent_id", async () => {
    const doInstance = makeSpaceDO();
    const created = await call(doInstance, "/projects", "POST", {
      space_id: "space1", name: "Support", default_agent_id: "launchpad-support-v1",
    });
    const patched = await call(doInstance, `/projects/${created.json.id}`, "PATCH", {
      default_agent_id: "launchpad-content-v1",
    });
    expect(patched.status).toBe(200);
    expect(patched.json.default_agent_id).toBe("launchpad-content-v1");
  });

  it("PATCH with default_agent_id: null clears an existing binding — the builder can always unbind a project", async () => {
    const doInstance = makeSpaceDO();
    const created = await call(doInstance, "/projects", "POST", {
      space_id: "space1", name: "Orders", default_agent_id: "launchpad-fulfillment-v1",
    });
    const patched = await call(doInstance, `/projects/${created.json.id}`, "PATCH", { default_agent_id: null });
    expect(patched.status).toBe(200);
    expect(patched.json.default_agent_id).toBeNull();
  });

  it("omitting default_agent_id from a PATCH body leaves the existing binding untouched", async () => {
    const doInstance = makeSpaceDO();
    const created = await call(doInstance, "/projects", "POST", {
      space_id: "space1", name: "Orders", default_agent_id: "launchpad-fulfillment-v1",
    });
    const patched = await call(doInstance, `/projects/${created.json.id}`, "PATCH", { description: "updated" });
    expect(patched.status).toBe(200);
    expect(patched.json.default_agent_id).toBe("launchpad-fulfillment-v1");
  });
});

// Round 2 of per-project configurability: max_threads (a hard cap on real conversations) and
// allowed_agent_ids (the thread-level "switch agent" allowlist — SpaceDO migration v19).
describe("SpaceDO projects — allowed_agent_ids (thread-level agent allowlist)", () => {
  it("defaults to null (unrestricted) when not set", async () => {
    const doInstance = makeSpaceDO();
    const created = await call(doInstance, "/projects", "POST", { space_id: "space1", name: "Orders" });
    expect(created.json.allowed_agent_ids).toBeNull();
  });

  it("persists a non-empty allowlist through create/GET/list", async () => {
    const doInstance = makeSpaceDO();
    const created = await call(doInstance, "/projects", "POST", {
      space_id: "space1", name: "Orders", allowed_agent_ids: ["launchpad-fulfillment-v1", "naelao-agent"],
    });
    expect(created.json.allowed_agent_ids).toEqual(["launchpad-fulfillment-v1", "naelao-agent"]);

    const got = await call(doInstance, `/projects/${created.json.id}`, "GET");
    expect(got.json.allowed_agent_ids).toEqual(["launchpad-fulfillment-v1", "naelao-agent"]);

    const list = await call(doInstance, "/projects?space_id=space1", "GET");
    expect(list.json.data[0].allowed_agent_ids).toEqual(["launchpad-fulfillment-v1", "naelao-agent"]);
  });

  it("rejects creation when default_agent_id is not a member of a non-empty allowed_agent_ids", async () => {
    const doInstance = makeSpaceDO();
    const created = await call(doInstance, "/projects", "POST", {
      space_id: "space1", name: "Orders",
      default_agent_id: "launchpad-support-v1",
      allowed_agent_ids: ["launchpad-fulfillment-v1"],
    });
    expect(created.status).toBe(400);
  });

  it("allows creation when default_agent_id IS a member of allowed_agent_ids", async () => {
    const doInstance = makeSpaceDO();
    const created = await call(doInstance, "/projects", "POST", {
      space_id: "space1", name: "Orders",
      default_agent_id: "launchpad-fulfillment-v1",
      allowed_agent_ids: ["launchpad-fulfillment-v1", "naelao-agent"],
    });
    expect(created.status).toBe(201);
  });

  it("PATCH rejects narrowing allowed_agent_ids to exclude the project's current default_agent_id", async () => {
    const doInstance = makeSpaceDO();
    const created = await call(doInstance, "/projects", "POST", {
      space_id: "space1", name: "Orders", default_agent_id: "launchpad-fulfillment-v1",
    });
    const patched = await call(doInstance, `/projects/${created.json.id}`, "PATCH", {
      allowed_agent_ids: ["launchpad-support-v1"],
    });
    expect(patched.status).toBe(400);
  });

  it("PATCH accepts setting both default_agent_id and allowed_agent_ids together consistently", async () => {
    const doInstance = makeSpaceDO();
    const created = await call(doInstance, "/projects", "POST", { space_id: "space1", name: "Orders" });
    const patched = await call(doInstance, `/projects/${created.json.id}`, "PATCH", {
      default_agent_id: "launchpad-fulfillment-v1",
      allowed_agent_ids: ["launchpad-fulfillment-v1", "naelao-agent"],
    });
    expect(patched.status).toBe(200);
    expect(patched.json.default_agent_id).toBe("launchpad-fulfillment-v1");
    expect(patched.json.allowed_agent_ids).toEqual(["launchpad-fulfillment-v1", "naelao-agent"]);
  });

  it("PATCH with allowed_agent_ids: [] clears the allowlist back to unrestricted", async () => {
    const doInstance = makeSpaceDO();
    const created = await call(doInstance, "/projects", "POST", {
      space_id: "space1", name: "Orders", allowed_agent_ids: ["launchpad-fulfillment-v1"],
    });
    const patched = await call(doInstance, `/projects/${created.json.id}`, "PATCH", { allowed_agent_ids: [] });
    expect(patched.status).toBe(200);
    expect(patched.json.allowed_agent_ids).toBeNull();
  });
});

describe("SpaceDO projects — max_threads + thread creation enforcement", () => {
  it("defaults to 0 (unlimited)", async () => {
    const doInstance = makeSpaceDO();
    const created = await call(doInstance, "/projects", "POST", { space_id: "space1", name: "Orders" });
    expect(created.json.max_threads).toBe(0);
  });

  it("rejects a negative or non-integer max_threads at creation", async () => {
    const doInstance = makeSpaceDO();
    const bad1 = await call(doInstance, "/projects", "POST", { space_id: "space1", name: "A", max_threads: -1 });
    expect(bad1.status).toBe(400);
    const bad2 = await call(doInstance, "/projects", "POST", { space_id: "space1", name: "B", max_threads: 1.5 });
    expect(bad2.status).toBe(400);
  });

  it("allows thread creation up to the configured cap, then rejects with 409 thread_limit_reached", async () => {
    const doInstance = makeSpaceDO();
    const project = await call(doInstance, "/projects", "POST", { space_id: "space1", name: "Orders", max_threads: 2 });
    const projectId = project.json.id;

    const t1 = await call(doInstance, "/threads", "POST", { space_id: "space1", project_id: projectId, title: "One" });
    expect(t1.status).toBe(201);
    const t2 = await call(doInstance, "/threads", "POST", { space_id: "space1", project_id: projectId, title: "Two" });
    expect(t2.status).toBe(201);

    const t3 = await call(doInstance, "/threads", "POST", { space_id: "space1", project_id: projectId, title: "Three" });
    expect(t3.status).toBe(409);
    expect(t3.json.error_code).toBe("thread_limit_reached");
  });

  it("archiving a thread frees a slot under the cap", async () => {
    const storage = createDOStorage();
    const sql = storage.sql;
    const doInstance = new SpaceDO({ storage } as never, { PLATFORM_SECRET: "test-secret" } as never);
    const project = await call(doInstance, "/projects", "POST", { space_id: "space1", name: "Orders", max_threads: 1 });
    const projectId = project.json.id;

    const t1 = await call(doInstance, "/threads", "POST", { space_id: "space1", project_id: projectId, title: "One" });
    expect(t1.status).toBe(201);
    const blocked = await call(doInstance, "/threads", "POST", { space_id: "space1", project_id: projectId, title: "Two" });
    expect(blocked.status).toBe(409);

    // Archive the first thread directly (no PATCH /threads/:id endpoint exists yet — this
    // exercises the enforcement query's own "status = 'active'" filter, not a new API surface).
    (sql as DOSqlStorage).exec("UPDATE threads SET status = 'archived' WHERE id = ?", t1.json.id);

    const t2 = await call(doInstance, "/threads", "POST", { space_id: "space1", project_id: projectId, title: "Three" });
    expect(t2.status).toBe(201);
  });

  it("does not count sub_agent threads toward the cap", async () => {
    const doInstance = makeSpaceDO();
    const project = await call(doInstance, "/projects", "POST", { space_id: "space1", name: "Orders", max_threads: 1 });
    const projectId = project.json.id;

    const primary = await call(doInstance, "/threads", "POST", { space_id: "space1", project_id: projectId, title: "Primary" });
    expect(primary.status).toBe(201);

    // A project already at its cap can still receive sub-agent fan-out threads (bounded
    // separately by MAX_SUB_AGENTS_PER_SPAWN/ConcurrencyDO, not by max_threads).
    const sub = await call(doInstance, "/threads", "POST", {
      space_id: "space1", project_id: projectId, title: "Sub", thread_kind: "sub_agent", parent_thread_id: primary.json.id,
    });
    expect(sub.status).toBe(201);
  });

  it("threads with no project_id are never capped", async () => {
    const doInstance = makeSpaceDO();
    // A project exists with max_threads: 1, but these threads don't reference it.
    await call(doInstance, "/projects", "POST", { space_id: "space1", name: "Orders", max_threads: 1 });
    const t1 = await call(doInstance, "/threads", "POST", { space_id: "space1", title: "One" });
    const t2 = await call(doInstance, "/threads", "POST", { space_id: "space1", title: "Two" });
    expect(t1.status).toBe(201);
    expect(t2.status).toBe(201);
  });
});
