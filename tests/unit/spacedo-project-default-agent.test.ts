import { describe, it, expect } from "vitest";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { createDOSqlStorage } from "./helpers/sqlite-do-shim.js";

// Templates ship pre-wired projects bound to whichever installed agent owns that project's
// work (spec follow-up: "prebuilt projects, threads, agents ... that's what a template should
// have, all preconfigured, but can be changed"). projects.default_agent_id (migration v18) is
// the persisted binding; it's a DEFAULT only, never an enforced identity, so it must be
// settable at creation, readable via GET/list, and freely reassignable/clearable via PATCH.

function makeSpaceDO(): SpaceDO {
  const ctx = { storage: { sql: createDOSqlStorage() } };
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
