import { describe, it, expect } from "vitest";
import { buildProjectMemoryStore, buildHybridMemoryStore } from "../../workers/agents/src/script-engine/project-memory-client.js";
import type { MemoryStore, MemoryRecallResult } from "../../workers/agents/src/script-engine/types.js";

// §A1.17 Phase U: the agents-worker side of project-shared memory. buildProjectMemoryStore is a
// thin HTTP client over SpaceDO's project-memory routes (tested at the SpaceDO level in
// project-memory-spacedo.test.ts); buildHybridMemoryStore is the composition logic that decides
// which store (local per-agent vs. project-shared) each MemoryStore op routes to.

function fetcherOf(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: async (input: string | Request, init?: RequestInit) => {
    const req = typeof input === "string" ? new Request(input, init) : input;
    return handler(req);
  } } as unknown as Fetcher;
}

const mintInternalToken = async () => "fake-token";

describe("buildProjectMemoryStore (HTTP client)", () => {
  function makeOpts(handler: (req: Request) => Promise<Response> | Response) {
    return {
      spacesWorker: fetcherOf(handler),
      platformSecret: "s",
      spaceId: "space-1",
      tenantId: "tenant-1",
      projectId: "proj-1",
      mintInternalToken,
    };
  }

  it("remember() calls the SpaceDO facts route with the right project scoping", async () => {
    let seenUrl = "";
    const store = buildProjectMemoryStore(makeOpts((req) => {
      seenUrl = req.url;
      return Response.json({ id: "fact-1" }, { status: 201 });
    }));
    const result = await store.remember({ text: "", entity: "e", relation: "r", attribute: "a" });
    expect(result).toEqual({ id: "fact-1" });
    expect(seenUrl).toBe("http://spaces-worker/spaces/space-1/projects/proj-1/memory/facts");
  });

  it("remember() with no entity/relation/attribute is a silent no-op (not a fact)", async () => {
    const store = buildProjectMemoryStore(makeOpts(() => { throw new Error("should not be called"); }));
    const result = await store.remember({ text: "just a note" });
    expect(result).toEqual({ id: "" });
  });

  it("recall() maps SpaceDO fact rows into MemoryRecallResult shape", async () => {
    const store = buildProjectMemoryStore(makeOpts(() =>
      Response.json({ data: [{ id: "f1", entity: "refund", relation: "is", attribute: "30 days", trust_score: 1 }] })
    ));
    const results = await store.recall({ text: "refund" });
    expect(results).toEqual([{ id: "f1", layer: "structured_fact", text: "refund is 30 days", entity: "refund", relation: "is", attribute: "30 days", score: 1 }]);
  });

  it("degrades to an empty array (never throws) when SpaceDO is unreachable", async () => {
    const store = buildProjectMemoryStore(makeOpts(() => new Response(null, { status: 500 })));
    expect(await store.recall({ text: "x" })).toEqual([]);
  });

  it("recordFabric/recallFabric/briefFabric round-trip through the fabric routes", async () => {
    const opts = makeOpts((req) => {
      const url = new URL(req.url);
      if (req.method === "POST") return Response.json({ id: "fab-1" }, { status: 201 });
      if (url.pathname.endsWith("/brief")) return Response.json({ data: [{ id: "fab-1", session_id: "s1", summary: "brief", key_insights: "[]", created_at: new Date().toISOString() }] });
      return Response.json({ data: [{ id: "fab-1", session_id: "s1", summary: "recalled", key_insights: "[]", created_at: new Date().toISOString(), score: 0.9 }] });
    });
    const store = buildProjectMemoryStore(opts);
    expect(await store.recordFabric({ sessionId: "s1", summary: "x" })).toEqual({ id: "fab-1" });
    const recalled = await store.recallFabric({ text: "x" });
    expect(recalled[0]?.summary).toBe("recalled");
    const brief = await store.briefFabric(undefined);
    expect(brief[0]?.summary).toBe("brief");
  });

  it("upsertWikiConcept/lookupWikiConcept/searchWiki round-trip through the wiki routes", async () => {
    const opts = makeOpts((req) => {
      if (req.method === "POST") return Response.json({ concept: "SLA" });
      const url = new URL(req.url);
      if (url.pathname.endsWith("/wiki")) return Response.json({ data: [{ concept: "SLA", definition: "d", relationships: "[]", updated_at: new Date().toISOString() }] });
      return Response.json({ data: { concept: "SLA", definition: "4h", relationships: "[]", updated_at: new Date().toISOString() } });
    });
    const store = buildProjectMemoryStore(opts);
    expect(await store.upsertWikiConcept({ concept: "SLA", definition: "4h" })).toEqual({ concept: "SLA" });
    const looked = await store.lookupWikiConcept(undefined, "SLA");
    expect(looked?.definition).toBe("4h");
    const searched = await store.searchWiki({ text: "d" });
    expect(searched).toHaveLength(1);
  });
});

describe("buildHybridMemoryStore (composition)", () => {
  function makeStore(overrides: Partial<MemoryStore> = {}): MemoryStore {
    return {
      remember: async () => ({ id: "unset" }),
      recall: async () => [],
      forget: async () => {},
      recordFabric: async () => ({ id: "unset" }),
      recallFabric: async () => [],
      briefFabric: async () => [],
      upsertWikiConcept: async () => ({ concept: "unset" }),
      lookupWikiConcept: async () => null,
      searchWiki: async () => [],
      ...overrides,
    };
  }

  it("routes a structured-fact remember() to the project store, not local", async () => {
    let calledProject = false;
    let calledLocal = false;
    const project = makeStore({ remember: async () => { calledProject = true; return { id: "p1" }; } });
    const local = makeStore({ remember: async () => { calledLocal = true; return { id: "l1" }; } });
    const hybrid = buildHybridMemoryStore(local, project);

    const result = await hybrid.remember({ text: "", entity: "e", relation: "r", attribute: "a" });
    expect(result).toEqual({ id: "p1" });
    expect(calledProject).toBe(true);
    expect(calledLocal).toBe(false);
  });

  it("routes a free-text episodic remember() to the LOCAL store, not project", async () => {
    let calledProject = false;
    let calledLocal = false;
    const project = makeStore({ remember: async () => { calledProject = true; return { id: "p1" }; } });
    const local = makeStore({ remember: async () => { calledLocal = true; return { id: "l1" }; } });
    const hybrid = buildHybridMemoryStore(local, project);

    const result = await hybrid.remember({ text: "just a note, no entity/relation/attribute" });
    expect(result).toEqual({ id: "l1" });
    expect(calledLocal).toBe(true);
    expect(calledProject).toBe(false);
  });

  it("recall() merges results from both stores, deduped by text with the higher score winning", async () => {
    const project = makeStore({
      recall: async () => [{ id: "p1", layer: "structured_fact", text: "shared fact", score: 0.9 } as MemoryRecallResult],
    });
    const local = makeStore({
      recall: async () => [
        { id: "l1", layer: "episodic", text: "local-only note", score: 0.5 } as MemoryRecallResult,
        { id: "l2", layer: "structured_fact", text: "shared fact", score: 0.3 } as MemoryRecallResult, // lower score, same text
      ],
    });
    const hybrid = buildHybridMemoryStore(local, project);
    const results = await hybrid.recall({ text: "x" });
    expect(results).toHaveLength(2);
    const sharedFact = results.find((r) => r.text === "shared fact");
    expect(sharedFact?.score).toBe(0.9); // project's higher score won, not local's 0.3
    expect(results.some((r) => r.text === "local-only note")).toBe(true);
  });

  it("recall() degrades gracefully when the project store throws", async () => {
    const project = makeStore({ recall: async () => { throw new Error("network down"); } });
    const local = makeStore({ recall: async () => [{ id: "l1", layer: "episodic", text: "still works", score: 0.5 } as MemoryRecallResult] });
    const hybrid = buildHybridMemoryStore(local, project);
    const results = await hybrid.recall({ text: "x" });
    expect(results).toEqual([{ id: "l1", layer: "episodic", text: "still works", score: 0.5 }]);
  });

  it("Fabric (L4) and Wiki (L6) ops ALWAYS route to the project store", async () => {
    let fabricCalled = false;
    let wikiCalled = false;
    const project = makeStore({
      recordFabric: async () => { fabricCalled = true; return { id: "f1" }; },
      upsertWikiConcept: async () => { wikiCalled = true; return { concept: "c1" }; },
    });
    const local = makeStore({
      recordFabric: async () => { throw new Error("local should never be called for fabric"); },
      upsertWikiConcept: async () => { throw new Error("local should never be called for wiki"); },
    });
    const hybrid = buildHybridMemoryStore(local, project);
    await hybrid.recordFabric({ sessionId: "s", summary: "x" });
    await hybrid.upsertWikiConcept({ concept: "c1", definition: "d" });
    expect(fabricCalled).toBe(true);
    expect(wikiCalled).toBe(true);
  });

  it("forget() attempts both stores, tolerating a project-side failure", async () => {
    let localForgotten = false;
    const project = makeStore({ forget: async () => { throw new Error("not found remotely"); } });
    const local = makeStore({ forget: async () => { localForgotten = true; } });
    const hybrid = buildHybridMemoryStore(local, project);
    await expect(hybrid.forget("id-1")).resolves.toBeUndefined();
    expect(localForgotten).toBe(true);
  });
});
