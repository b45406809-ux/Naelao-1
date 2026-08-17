import { describe, it, expect, vi } from "vitest";
import { knowledgeBase } from "../../workers/agents/src/script-engine/prebuilt/knowledge-base.js";
import type { ScriptEngineEnv } from "../../workers/agents/src/script-engine/types.js";

// Phase 5: knowledge.index and knowledge.delete previously called routes that HAVE NEVER EXISTED
// on the real knowledge worker (POST /kb/index, DELETE /kb/{id}) — every real call 404'd. This
// file drives the real ops against a fake Fetcher that only answers the REAL routes
// (/kb/documents POST, /kb/documents/:docId DELETE), the way an incorrect implementation would
// have failed loudly against — a fake that answered every path would have hidden the bug the same
// way its absence did before this pass.

function fakeKnowledgeWorker(): { fetcher: Fetcher; calls: Array<{ method: string; path: string; body?: unknown }> } {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const fetcher: Fetcher = {
    fetch: async (input: RequestInfo) => {
      const req = input as Request;
      const url = new URL(req.url);
      const body = req.method !== "GET" ? await req.clone().json().catch(() => undefined) : undefined;
      calls.push({ method: req.method, path: url.pathname + url.search, body });
      if (req.method === "GET" && url.pathname === "/spaces/space1/kb/search") {
        return Response.json({ results: [{ id: "doc1", text: "found it" }] });
      }
      if (req.method === "POST" && url.pathname === "/spaces/space1/kb/documents") {
        return Response.json({ id: "doc-new", title: (body as { title?: string })?.title, status: "indexed" }, { status: 201 });
      }
      if (req.method === "DELETE" && url.pathname === "/spaces/space1/kb/documents/doc-new") {
        return Response.json({ deleted: true });
      }
      // Any other path — including the OLD, wrong ones — 404s, exactly like the real worker does.
      return new Response("not found", { status: 404 });
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

function ctxWith(knowledgeWorker: Fetcher, extra?: Partial<ScriptEngineEnv>) {
  const env = {
    spaceId: "space1",
    agentId: "agent1",
    tenantId: "tenant1",
    platformSecret: "test-secret",
    scriptsBucket: {} as R2Bucket,
    knowledgeWorker,
    ...extra,
  } as ScriptEngineEnv;
  return { env, run: vi.fn() };
}

describe("knowledge-base prebuilt — real route contract", () => {
  it("knowledge.search hits the real /kb/search route and returns results", async () => {
    const { fetcher } = fakeKnowledgeWorker();
    const ctx = ctxWith(fetcher);
    const result = await knowledgeBase.operations["knowledge.search"]!({ query: "tea" }, ctx);
    expect(result).toMatchObject({ results: [{ id: "doc1" }] });
  });

  it("knowledge.index posts to the REAL /kb/documents route with title+content — not the old, nonexistent /kb/index", async () => {
    const { fetcher, calls } = fakeKnowledgeWorker();
    const ctx = ctxWith(fetcher);
    const result = await knowledgeBase.operations["knowledge.index"]!(
      { title: "Refund policy", content: "30 days, no questions asked." },
      ctx
    );
    const call = calls.find((c) => c.method === "POST");
    expect(call).toBeDefined();
    expect(call!.path).toBe("/spaces/space1/kb/documents");
    expect(call!.body).toMatchObject({ title: "Refund policy", content: "30 days, no questions asked.", content_type: "text" });
    expect(result).toMatchObject({ id: "doc-new", status: "indexed" });
  });

  it("knowledge.index scopes to the caller's own project when project-scoped", async () => {
    const { fetcher, calls } = fakeKnowledgeWorker();
    const ctx = ctxWith(fetcher, { projectId: "proj-1" });
    await knowledgeBase.operations["knowledge.index"]!({ title: "T", content: "C" }, ctx);
    const call = calls.find((c) => c.method === "POST");
    expect(call!.body).toMatchObject({ project_id: "proj-1" });
  });

  it("knowledge.index never sends project_id for the space-wide assistant (no projectId on env)", async () => {
    const { fetcher, calls } = fakeKnowledgeWorker();
    const ctx = ctxWith(fetcher);
    await knowledgeBase.operations["knowledge.index"]!({ title: "T", content: "C" }, ctx);
    const call = calls.find((c) => c.method === "POST");
    expect(call!.body).not.toHaveProperty("project_id");
  });

  it("knowledge.index rejects a missing title before ever calling the worker", async () => {
    const { fetcher, calls } = fakeKnowledgeWorker();
    const ctx = ctxWith(fetcher);
    await expect(knowledgeBase.operations["knowledge.index"]!({ content: "C" }, ctx)).rejects.toThrow(/title/);
    expect(calls).toHaveLength(0);
  });

  it("knowledge.index rejects missing content before ever calling the worker", async () => {
    const { fetcher, calls } = fakeKnowledgeWorker();
    const ctx = ctxWith(fetcher);
    await expect(knowledgeBase.operations["knowledge.index"]!({ title: "T" }, ctx)).rejects.toThrow(/content/);
    expect(calls).toHaveLength(0);
  });

  it("knowledge.delete DELETEs the REAL /kb/documents/:docId route — not the old, nonexistent /kb/{id}", async () => {
    const { fetcher, calls } = fakeKnowledgeWorker();
    const ctx = ctxWith(fetcher);
    const result = await knowledgeBase.operations["knowledge.delete"]!({ id: "doc-new" }, ctx);
    const call = calls.find((c) => c.method === "DELETE");
    expect(call).toBeDefined();
    expect(call!.path).toBe("/spaces/space1/kb/documents/doc-new");
    expect(result).toEqual({ ok: true });
  });

  it("knowledge.delete requires an id", async () => {
    const { fetcher, calls } = fakeKnowledgeWorker();
    const ctx = ctxWith(fetcher);
    await expect(knowledgeBase.operations["knowledge.delete"]!({}, ctx)).rejects.toThrow(/id/);
    expect(calls).toHaveLength(0);
  });

  it("a genuine worker-side failure surfaces the real status and body, not a swallowed generic error", async () => {
    const { fetcher } = fakeKnowledgeWorker();
    const ctx = ctxWith(fetcher);
    // A doc id that doesn't exist on the fake worker — 404 from the real /kb/documents/:docId route.
    await expect(knowledgeBase.operations["knowledge.delete"]!({ id: "not-real" }, ctx)).rejects.toThrow(/404/);
  });

  it("throws a clear configuration error when knowledgeWorker isn't bound, rather than a null-deref", async () => {
    const ctx = ctxWith(undefined as unknown as Fetcher, {});
    delete (ctx.env as Partial<ScriptEngineEnv>).knowledgeWorker;
    await expect(knowledgeBase.operations["knowledge.search"]!({ query: "x" }, ctx)).rejects.toThrow(/KNOWLEDGE_WORKER/);
  });

  it("declares paramHints for all three ops, naming the real required fields", () => {
    expect(knowledgeBase.paramHints?.["knowledge.index"]).toMatch(/title/);
    expect(knowledgeBase.paramHints?.["knowledge.index"]).toMatch(/content/);
    expect(knowledgeBase.paramHints?.["knowledge.delete"]).toMatch(/id/);
  });
});
