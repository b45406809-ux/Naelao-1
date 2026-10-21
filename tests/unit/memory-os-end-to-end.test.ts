// Memory OS, end to end across all six layers — and specifically the boundary between them.
//
// Seven test files already cover the layers individually. What none of them asserted is the
// question that actually decides whether multi-thread projects work:
//
//   which memory is SHARED across a project, and which stays private to one thread?
//
// The intended split (Phase U):
//   L3 facts, L4 fabric, L6 wiki  → project-shared, so an agent in thread B knows what thread A
//                                   established as true.
//   L5 episodic/semantic          → private per (thread, agent), so one thread's half-formed
//                                   reasoning never leaks in and mislead another.
//
// Get this wrong in either direction and the product breaks in a way tests of a single layer
// cannot see: share too much and agents contaminate each other; share too little and they
// silently redo each other's work.

import { describe, it, expect } from "vitest";
import { initMemorySchema, buildMemoryStore, runMemoryMaintenance } from "../../workers/agents/src/script-engine/memory-os.js";
import { buildProjectMemoryStore, buildHybridMemoryStore } from "../../workers/agents/src/script-engine/project-memory-client.js";
import type { MemoryStore } from "../../workers/agents/src/script-engine/types.js";
import { createDOSqlStorage } from "./helpers/sqlite-do-shim.js";

function sqlShim() {
  // The repo's shared DO-SQLite shim — same engine and same restrictions the real DO storage
  // enforces, rather than a hand-rolled one that could quietly diverge from production.
  return createDOSqlStorage();
}

/** A deterministic embedder — recall behaviour must be assertable without a real model. */
function fakeEmbedder() {
  return {
    // Note the signature: embed takes ONE string, not an array — getting this wrong makes
    // promotion silently fail (the throw is caught and the note is left unpromoted), which is
    // exactly the kind of quiet no-op an end-to-end test exists to catch.
    async embed(text: string): Promise<number[]> {
      const v = new Array(8).fill(0);
      for (const ch of text.toLowerCase()) v[ch.charCodeAt(0) % 8] += 1;
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    },
  };
}

/** An in-memory Vectorize stand-in with real cosine scoring, so promotion + recall are exercised
 *  rather than stubbed away. */
function fakeVectorIndex() {
  const vectors: Array<{ id: string; values: number[]; metadata: Record<string, unknown> }> = [];
  return {
    store: vectors,
    async upsert(items: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }>) {
      for (const it of items) {
        const existing = vectors.findIndex((v) => v.id === it.id);
        const row = { id: it.id, values: it.values, metadata: it.metadata ?? {} };
        if (existing >= 0) vectors[existing] = row;
        else vectors.push(row);
      }
      return { count: items.length };
    },
    async query(values: number[], opts?: { topK?: number; filter?: Record<string, unknown> }) {
      const filter = opts?.filter ?? {};
      const matches = vectors
        .filter((v) =>
          Object.entries(filter).every(([k, cond]) => {
            const want = (cond as { $eq?: unknown })?.$eq;
            return want === undefined || v.metadata[k] === want;
          })
        )
        .map((v) => ({
          id: v.id,
          score: v.values.reduce((s, x, i) => s + x * (values[i] ?? 0), 0),
          metadata: v.metadata,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, opts?.topK ?? 5);
      return { matches };
    },
    async deleteByIds(ids: string[]) {
      for (const id of ids) {
        const i = vectors.findIndex((v) => v.id === id);
        if (i >= 0) vectors.splice(i, 1);
      }
      return { count: ids.length };
    },
  };
}

function localStore(spaceId = "space-1") {
  const sql = sqlShim();
  initMemorySchema(sql);
  const vectorIndex = fakeVectorIndex();
  const opts = { sql, spaceId, vectorIndex: vectorIndex as never, embedder: fakeEmbedder() as never };
  return { store: buildMemoryStore(opts), opts, vectorIndex };
}

/** A project-shared store backed by an in-memory map, standing in for SpaceDO's routes (which
 *  have their own tests) — what matters here is the ROUTING, not SpaceDO's SQL. */
function sharedProjectStore() {
  const facts: Array<{ id: string; entity: string; relation: string; attribute: string; trust_score: number }> = [];
  const fabric: Array<{ id: string; session_id: string; summary: string }> = [];
  const wiki = new Map<string, { concept: string; definition: string }>();

  const fetcher = {
    async fetch(input: string | Request, init?: RequestInit) {
      const req = typeof input === "string" ? new Request(input, init) : input;
      const url = new URL(req.url);
      const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, string>) : {};

      if (url.pathname.endsWith("/memory/facts")) {
        if (req.method === "POST") {
          const row = {
            id: `f${facts.length + 1}`,
            entity: body["entity"] ?? "",
            relation: body["relation"] ?? "",
            attribute: body["attribute"] ?? "",
            trust_score: 1,
          };
          facts.push(row);
          return Response.json({ id: row.id }, { status: 201 });
        }
        const q = (url.searchParams.get("q") ?? "").toLowerCase();
        // Token match, mirroring what recall really does — a naive whole-phrase includes() would
        // make this fake stricter than production and fail tests that production would pass.
        const terms = q.split(/[^a-z0-9]+/).filter((t) => t.length > 2);
        return Response.json({
          data: facts.filter((f) => {
            if (terms.length === 0) return true;
            const hay = `${f.entity} ${f.relation} ${f.attribute}`.toLowerCase();
            return terms.some((t) => hay.includes(t));
          }),
        });
      }
      if (url.pathname.endsWith("/memory/fabric/brief")) {
        return Response.json({ data: fabric });
      }
      if (url.pathname.endsWith("/memory/fabric")) {
        if (req.method === "POST") {
          const row = { id: `fb${fabric.length + 1}`, session_id: body["session_id"] ?? "", summary: body["summary"] ?? "" };
          fabric.push(row);
          return Response.json({ id: row.id }, { status: 201 });
        }
        return Response.json({ data: fabric });
      }
      if (url.pathname.includes("/memory/wiki")) {
        if (req.method === "POST") {
          wiki.set(body["concept"] ?? "", { concept: body["concept"] ?? "", definition: body["definition"] ?? "" });
          return Response.json({ ok: true }, { status: 201 });
        }
        // The real client looks a concept up as a PATH segment (/memory/wiki/{concept}),
        // not a query param.
        const m = /\/memory\/wiki\/(.+)$/.exec(url.pathname);
        const concept = m ? decodeURIComponent(m[1]!) : null;
        // The real client unwraps `{ data: ... }` and JSON-parses `relationships`.
        const shape = (a: { concept: string; definition: string }) => ({
          concept: a.concept,
          definition: a.definition,
          relationships: "[]",
          updated_at: new Date().toISOString(),
        });
        if (concept) {
          const a = wiki.get(concept);
          return a ? Response.json({ data: shape(a) }) : new Response("not found", { status: 404 });
        }
        return Response.json({ data: [...wiki.values()].map(shape) });
      }
      return new Response("not found", { status: 404 });
    },
  } as unknown as Fetcher;

  const store = buildProjectMemoryStore({
    spacesWorker: fetcher,
    platformSecret: "s",
    spaceId: "space-1",
    tenantId: "tenant-1",
    projectId: "proj-1",
    mintInternalToken: async () => "tok",
  });
  return { store, facts, fabric, wiki };
}

/** Two threads in the SAME project: separate local (L5) stores, one shared project store. */
function twoThreadsOneProject() {
  const shared = sharedProjectStore();
  const threadA = localStore();
  const threadB = localStore();
  return {
    shared,
    a: buildHybridMemoryStore(threadA.store, shared.store) as MemoryStore,
    b: buildHybridMemoryStore(threadB.store, shared.store) as MemoryStore,
    rawA: threadA,
    rawB: threadB,
  };
}

describe("Memory OS end-to-end — a single agent across all six layers", () => {
  it("stores and recalls a structured fact (L3)", async () => {
    const { store } = localStore();
    await store.remember({ text: "refund window is 30 days", entity: "refund", relation: "window", attribute: "30 days" });
    const hits = await store.recall({ text: "refund window" });
    expect(hits.length).toBeGreaterThan(0);
    expect(JSON.stringify(hits)).toContain("30 days");
  });

  it("records and recalls a cross-session summary (L4 Fabric)", async () => {
    const { store } = localStore();
    await store.recordFabric({ sessionId: "s1", summary: "Set up the Whop storefront and priced the course at 49 USD." });
    const brief = await store.briefFabric(undefined, 5);
    expect(brief.length).toBe(1);
    expect(brief[0]?.summary).toContain("49 USD");
  });

  it("curates and looks up a concept (L6 Wiki)", async () => {
    const { store } = localStore();
    await store.upsertWikiConcept({ concept: "EARLYBIRD", definition: "The launch discount code, 20% off." });
    const article = await store.lookupWikiConcept(undefined, "EARLYBIRD");
    expect(article?.definition).toContain("20% off");
  });

  it("promotes an important episodic note into semantic memory (L5)", async () => {
    // The episodic→semantic promotion is what makes memory durable rather than a rolling log;
    // it runs in maintenance, not on write, so this exercises the real path.
    const { store, opts, vectorIndex } = localStore();
    await store.remember({ text: "The owner wants payouts to Revolut, never PayPal.", importance: 0.95 });
    const before = vectorIndex.store.length;
    const result = await runMemoryMaintenance(opts as never);
    expect(result.promoted).toBeGreaterThan(0);
    expect(vectorIndex.store.length).toBeGreaterThan(before);

    const hits = await store.recall({ text: "Revolut payouts" });
    expect(JSON.stringify(hits)).toContain("Revolut");
  });

  it("does not promote low-importance chatter", async () => {
    const { store, opts, vectorIndex } = localStore();
    await store.remember({ text: "ok thanks", importance: 0.1 });
    await runMemoryMaintenance(opts as never);
    expect(vectorIndex.store.length).toBe(0);
  });

  it("forgets a fact on request", async () => {
    const { store } = localStore();
    const { id } = await store.remember({ text: "x", entity: "temp", relation: "is", attribute: "wrong" });
    await store.forget(id);
    const hits = await store.recall({ text: "temp" });
    expect(JSON.stringify(hits)).not.toContain("wrong");
  });
});

describe("Memory OS end-to-end — the project/thread boundary", () => {
  it("SHARES a structured fact (L3) between two threads in the same project", async () => {
    // Thread B must not re-ask something thread A already established.
    const { a, b, shared } = twoThreadsOneProject();
    await a.remember({ text: "", entity: "payout", relation: "destination", attribute: "Revolut" });
    expect(shared.facts).toHaveLength(1);

    const hits = await b.recall({ text: "payout" });
    expect(JSON.stringify(hits)).toContain("Revolut");
  });

  it("SHARES fabric (L4) and wiki (L6) between threads", async () => {
    const { a, b, shared } = twoThreadsOneProject();
    await a.recordFabric({ sessionId: "s1", summary: "Storefront is live." });
    await a.upsertWikiConcept({ concept: "EARLYBIRD", definition: "20% launch code" });

    expect(shared.fabric).toHaveLength(1);
    expect(await b.briefFabric(undefined, 5)).toHaveLength(1);
    expect((await b.lookupWikiConcept(undefined, "EARLYBIRD"))?.definition).toContain("20%");
  });

  it("KEEPS an episodic note (L5) private to the thread that wrote it", async () => {
    // The reason for the whole split: one thread's loose, half-formed reasoning must never
    // surface in another thread as if it were established fact.
    const { a, b, shared } = twoThreadsOneProject();
    await a.remember({ text: "user seemed unsure about the 49 dollar price, maybe try 39" });

    // It never became a project fact...
    expect(shared.facts).toHaveLength(0);
    // ...and thread B cannot see it.
    expect(JSON.stringify(await b.recall({ text: "unsure about the price" }))).not.toContain("maybe try 39");
    // ...while the thread that wrote it still can.
    expect(JSON.stringify(await a.recall({ text: "unsure about the price" }))).toContain("maybe try 39");
  });

  it("merges project facts and the thread's own episodic notes on recall", async () => {
    // An agent should see BOTH what the project established and what it personally observed.
    const { a } = twoThreadsOneProject();
    await a.remember({ text: "", entity: "payout", relation: "destination", attribute: "Revolut" });
    await a.remember({ text: "the owner replies fastest about payouts in the evening" });

    // Use one query that genuinely targets both durable payout configuration and episodic
    // payout observations. The strict fact relevance gate intentionally rejects a fact when
    // most meaningful query terms point elsewhere.
    const merged = JSON.stringify(await a.recall({ text: "payout" }));
    expect(merged).toContain("Revolut");
    expect(merged).toContain("evening");
  });

  it("keeps two DIFFERENT projects fully separate", async () => {
    const projectOne = twoThreadsOneProject();
    const projectTwo = twoThreadsOneProject();
    await projectOne.a.remember({ text: "", entity: "payout", relation: "destination", attribute: "Revolut" });
    expect(projectTwo.shared.facts).toHaveLength(0);
    expect(JSON.stringify(await projectTwo.a.recall({ text: "payout" }))).not.toContain("Revolut");
  });

  it("the Space Assistant's own unscoped store is unaffected by project memory", async () => {
    // No projectId means the assistant uses the local store directly, unwrapped — it must not
    // accidentally inherit a project's facts.
    const assistant = localStore();
    const project = twoThreadsOneProject();
    await project.a.remember({ text: "", entity: "payout", relation: "destination", attribute: "Revolut" });
    expect(JSON.stringify(await assistant.store.recall({ text: "payout" }))).not.toContain("Revolut");
  });
});
