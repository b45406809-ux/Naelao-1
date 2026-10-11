import { describe, it, expect } from "vitest";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { createDOStorage } from "./helpers/sqlite-do-shim.js";

// §A1.17 Phase U: project-scoped Memory OS Layers 3 (facts)/4 (fabric)/6 (wiki), implemented as
// new SpaceDO routes so every agent thread bound to the SAME project can share them (T2 gave
// each (thread, agentId) pair its own local memory, which would otherwise mean zero sharing).

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

describe("Project-scoped facts (Layer 3)", () => {
  it("remembers a fact, then recalls it by a text match against entity/relation/attribute", async () => {
    const doInstance = makeSpaceDO();
    const remembered = await call(doInstance, "/projects/proj-1/memory/facts", "POST", { entity: "refund_policy", relation: "is", attribute: "30 days" });
    expect(remembered.status).toBe(201);

    const recalled = await call(doInstance, "/projects/proj-1/memory/facts?q=refund", "GET");
    expect(recalled.json.data).toHaveLength(1);
    expect(recalled.json.data[0]).toMatchObject({ entity: "refund_policy", relation: "is", attribute: "30 days" });
  });

  it("does not return a trusted fact that is only partially related to the query", async () => {
    const doInstance = makeSpaceDO();
    await call(doInstance, "/projects/proj-1/memory/facts", "POST", { entity: "refund_policy", relation: "is", attribute: "30 days" });

    const unrelated = await call(doInstance, "/projects/proj-1/memory/facts?q=refund+window", "GET");

    expect(unrelated.json.data).toHaveLength(0);
  });

  it("re-remembering the same (entity, relation) updates the attribute in place, not a duplicate", async () => {
    const doInstance = makeSpaceDO();
    await call(doInstance, "/projects/proj-1/memory/facts", "POST", { entity: "refund_policy", relation: "is", attribute: "30 days" });
    await call(doInstance, "/projects/proj-1/memory/facts", "POST", { entity: "refund_policy", relation: "is", attribute: "14 days" });
    const recalled = await call(doInstance, "/projects/proj-1/memory/facts?q=refund", "GET");
    expect(recalled.json.data).toHaveLength(1);
    expect(recalled.json.data[0].attribute).toBe("14 days");
  });

  it("facts are isolated per project — a fact in proj-1 is invisible from proj-2", async () => {
    const doInstance = makeSpaceDO();
    await call(doInstance, "/projects/proj-1/memory/facts", "POST", { entity: "e", relation: "r", attribute: "a" });
    const other = await call(doInstance, "/projects/proj-2/memory/facts?q=e", "GET");
    expect(other.json.data).toHaveLength(0);
  });

  it("deletes a fact by id", async () => {
    const doInstance = makeSpaceDO();
    const created = await call(doInstance, "/projects/proj-1/memory/facts", "POST", { entity: "e", relation: "r", attribute: "a" });
    await call(doInstance, `/projects/proj-1/memory/facts/${created.json.id}`, "DELETE");
    const recalled = await call(doInstance, "/projects/proj-1/memory/facts?q=e", "GET");
    expect(recalled.json.data).toHaveLength(0);
  });

  it("rejects a fact missing entity/relation/attribute", async () => {
    const doInstance = makeSpaceDO();
    const res = await call(doInstance, "/projects/proj-1/memory/facts", "POST", { entity: "e" });
    expect(res.status).toBe(400);
  });
});

describe("Project-scoped fabric (Layer 4)", () => {
  it("records an entry and recalls it by relevance to a query", async () => {
    const doInstance = makeSpaceDO();
    await call(doInstance, "/projects/proj-1/memory/fabric", "POST", { session_id: "sess-a", summary: "Discussed onboarding flow improvements", key_insights: ["shorten signup"] });
    const recalled = await call(doInstance, "/projects/proj-1/memory/fabric?q=onboarding", "GET");
    expect(recalled.json.data).toHaveLength(1);
    expect(recalled.json.data[0].summary).toContain("onboarding");
  });

  it("a query with no relevant match returns nothing (score floor)", async () => {
    const doInstance = makeSpaceDO();
    await call(doInstance, "/projects/proj-1/memory/fabric", "POST", { session_id: "sess-a", summary: "Discussed onboarding flow", key_insights: [] });
    const recalled = await call(doInstance, "/projects/proj-1/memory/fabric?q=totally+unrelated+topic", "GET");
    expect(recalled.json.data).toHaveLength(0);
  });

  it("brief returns the most recent entries with no query needed", async () => {
    const doInstance = makeSpaceDO();
    await call(doInstance, "/projects/proj-1/memory/fabric", "POST", { session_id: "sess-a", summary: "first", key_insights: [] });
    await call(doInstance, "/projects/proj-1/memory/fabric", "POST", { session_id: "sess-b", summary: "second", key_insights: [] });
    const brief = await call(doInstance, "/projects/proj-1/memory/fabric/brief?limit=1", "GET");
    expect(brief.json.data).toHaveLength(1);
    expect(brief.json.data[0].summary).toBe("second");
  });

  it("fabric is isolated per project", async () => {
    const doInstance = makeSpaceDO();
    await call(doInstance, "/projects/proj-1/memory/fabric", "POST", { session_id: "s", summary: "shared knowledge X", key_insights: [] });
    const other = await call(doInstance, "/projects/proj-2/memory/fabric?q=shared+knowledge", "GET");
    expect(other.json.data).toHaveLength(0);
  });
});

describe("Project-scoped wiki (Layer 6)", () => {
  it("upserts a concept and looks it up by name", async () => {
    const doInstance = makeSpaceDO();
    await call(doInstance, "/projects/proj-1/memory/wiki", "POST", { concept: "SLA", definition: "4-hour response time", relationships: [] });
    const looked = await call(doInstance, "/projects/proj-1/memory/wiki/SLA", "GET");
    expect(looked.json.data.definition).toBe("4-hour response time");
  });

  it("upserting the same concept again updates the definition, not a duplicate", async () => {
    const doInstance = makeSpaceDO();
    await call(doInstance, "/projects/proj-1/memory/wiki", "POST", { concept: "SLA", definition: "4-hour", relationships: [] });
    await call(doInstance, "/projects/proj-1/memory/wiki", "POST", { concept: "SLA", definition: "2-hour", relationships: [] });
    const looked = await call(doInstance, "/projects/proj-1/memory/wiki/SLA", "GET");
    expect(looked.json.data.definition).toBe("2-hour");
  });

  it("returns null for a concept that doesn't exist", async () => {
    const doInstance = makeSpaceDO();
    const looked = await call(doInstance, "/projects/proj-1/memory/wiki/NoSuchConcept", "GET");
    expect(looked.json.data).toBeNull();
  });

  it("searches concepts by definition text", async () => {
    const doInstance = makeSpaceDO();
    await call(doInstance, "/projects/proj-1/memory/wiki", "POST", { concept: "SLA", definition: "response time guarantee", relationships: [] });
    const searched = await call(doInstance, "/projects/proj-1/memory/wiki?q=guarantee", "GET");
    expect(searched.json.data).toHaveLength(1);
  });

  it("wiki concepts are isolated per project", async () => {
    const doInstance = makeSpaceDO();
    await call(doInstance, "/projects/proj-1/memory/wiki", "POST", { concept: "SLA", definition: "d", relationships: [] });
    const other = await call(doInstance, "/projects/proj-2/memory/wiki/SLA", "GET");
    expect(other.json.data).toBeNull();
  });
});
