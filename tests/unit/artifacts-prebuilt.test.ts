import { describe, it, expect, vi } from "vitest";
import { artifacts } from "../../workers/agents/src/script-engine/prebuilt/artifacts.js";
import type { ScriptEngineEnv } from "../../workers/agents/src/script-engine/types.js";

// Phase 5: the artifacts prebuilt is the agent-facing half of the new Artifacts feature — routes
// through the (previously orphaned, now hardened) artifact worker's real /spaces/:spaceId/
// artifacts contract via a direct service binding.

function fakeArtifactWorker(): { fetcher: Fetcher; calls: Array<{ method: string; path: string; query: string; body?: unknown }> } {
  const calls: Array<{ method: string; path: string; query: string; body?: unknown }> = [];
  const store = new Map<string, { filename: string; content: string; content_type: string }>();
  const fetcher: Fetcher = {
    fetch: async (input: RequestInfo) => {
      const req = input as Request;
      const url = new URL(req.url);
      const body = req.method !== "GET" && req.method !== "DELETE" ? await req.clone().json().catch(() => undefined) : undefined;
      calls.push({ method: req.method, path: url.pathname, query: url.search, body });

      if (req.method === "POST" && url.pathname === "/spaces/space1/artifacts") {
        const b = body as { filename: string; content: string; content_type?: string };
        const id = "art-1";
        store.set(id, { filename: b.filename, content: b.content, content_type: b.content_type ?? "text/plain" });
        return Response.json({ artifact_id: id, filename: b.filename, content_type: b.content_type ?? "text/plain", size: b.content.length }, { status: 201 });
      }
      if (req.method === "GET" && url.pathname === "/spaces/space1/artifacts") {
        return Response.json({
          data: [...store.entries()].map(([id, v]) => ({ artifact_id: id, filename: v.filename, content_type: v.content_type, size: v.content.length, uploaded: "2026-01-01" })),
          count: store.size,
        });
      }
      if (req.method === "GET" && url.pathname.startsWith("/spaces/space1/artifacts/")) {
        const id = url.pathname.split("/").pop()!;
        const found = store.get(id);
        if (!found) return new Response(JSON.stringify({ error_code: "not_found" }), { status: 404 });
        return new Response(found.content, { headers: { "content-type": found.content_type, "x-artifact-filename": encodeURIComponent(found.filename) } });
      }
      if (req.method === "DELETE" && url.pathname.startsWith("/spaces/space1/artifacts/")) {
        const id = url.pathname.split("/").pop()!;
        if (!store.has(id)) return new Response(JSON.stringify({ error_code: "not_found" }), { status: 404 });
        store.delete(id);
        return Response.json({ deleted: true, count: 1 });
      }
      return new Response("not found", { status: 404 });
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

function ctxWith(artifactWorker: Fetcher) {
  const env = {
    spaceId: "space1",
    agentId: "agent1",
    tenantId: "tenant1",
    platformSecret: "test-secret",
    scriptsBucket: {} as R2Bucket,
    artifactWorker,
  } as ScriptEngineEnv;
  return { env, run: vi.fn() };
}

describe("artifacts prebuilt — real route contract", () => {
  it("artifacts.create posts to the real /spaces/:spaceId/artifacts route", async () => {
    const { fetcher, calls } = fakeArtifactWorker();
    const ctx = ctxWith(fetcher);
    const result = await artifacts.operations["artifacts.create"]!(
      { filename: "report.html", content: "<h1>hi</h1>", content_type: "text/html" },
      ctx
    );
    expect(calls[0]).toMatchObject({ method: "POST", path: "/spaces/space1/artifacts" });
    expect(result).toMatchObject({ artifact_id: "art-1", filename: "report.html" });
  });

  it("artifacts.create rejects a missing filename before calling the worker", async () => {
    const { fetcher, calls } = fakeArtifactWorker();
    const ctx = ctxWith(fetcher);
    await expect(artifacts.operations["artifacts.create"]!({ content: "x" }, ctx)).rejects.toThrow(/filename/);
    expect(calls).toHaveLength(0);
  });

  it("artifacts.create rejects missing content before calling the worker", async () => {
    const { fetcher, calls } = fakeArtifactWorker();
    const ctx = ctxWith(fetcher);
    await expect(artifacts.operations["artifacts.create"]!({ filename: "x.txt" }, ctx)).rejects.toThrow(/content/);
    expect(calls).toHaveLength(0);
  });

  it("artifacts.list returns everything created", async () => {
    const { fetcher } = fakeArtifactWorker();
    const ctx = ctxWith(fetcher);
    await artifacts.operations["artifacts.create"]!({ filename: "a.txt", content: "x" }, ctx);
    const result = (await artifacts.operations["artifacts.list"]!({}, ctx)) as { data: unknown[]; count: number };
    expect(result.count).toBe(1);
  });

  it("artifacts.list forwards a bounded-page cursor to the artifact worker", async () => {
    const { fetcher, calls } = fakeArtifactWorker();
    const ctx = ctxWith(fetcher);
    await artifacts.operations["artifacts.list"]!({ limit: 25, cursor: "opaque-page-2" }, ctx);
    expect(calls[0]).toMatchObject({ method: "GET", query: "?limit=25&cursor=opaque-page-2" });
  });

  it("artifacts.get returns real text content for a text artifact", async () => {
    const { fetcher } = fakeArtifactWorker();
    const ctx = ctxWith(fetcher);
    const created = (await artifacts.operations["artifacts.create"]!(
      { filename: "notes.md", content: "# hi", content_type: "text/markdown" },
      ctx
    )) as { artifact_id: string };
    const result = (await artifacts.operations["artifacts.get"]!({ artifact_id: created.artifact_id }, ctx)) as { content: string; filename: string };
    expect(result.content).toBe("# hi");
    expect(result.filename).toBe("notes.md");
  });

  it("decodes the RFC3986 artifact filename header without corrupting Unicode names", async () => {
    const { fetcher } = fakeArtifactWorker();
    const ctx = ctxWith(fetcher);
    const created = (await artifacts.operations["artifacts.create"]!(
      { filename: "caf\u00e9.html", content: "<h1>hi</h1>", content_type: "text/html" },
      ctx,
    )) as { artifact_id: string };
    const result = (await artifacts.operations["artifacts.get"]!({ artifact_id: created.artifact_id }, ctx)) as { filename: string };
    expect(result.filename).toBe("caf\u00e9.html");
  });

  it("artifacts.get requires an artifact_id", async () => {
    const { fetcher } = fakeArtifactWorker();
    const ctx = ctxWith(fetcher);
    await expect(artifacts.operations["artifacts.get"]!({}, ctx)).rejects.toThrow(/artifact_id/);
  });

  it("artifacts.delete removes it — a following list is empty", async () => {
    const { fetcher } = fakeArtifactWorker();
    const ctx = ctxWith(fetcher);
    const created = (await artifacts.operations["artifacts.create"]!({ filename: "temp.txt", content: "x" }, ctx)) as { artifact_id: string };
    const delResult = await artifacts.operations["artifacts.delete"]!({ artifact_id: created.artifact_id }, ctx);
    expect(delResult).toEqual({ ok: true });
    const list = (await artifacts.operations["artifacts.list"]!({}, ctx)) as { count: number };
    expect(list.count).toBe(0);
  });

  it("a genuine 404 from the worker surfaces as a real error, not a swallowed generic one", async () => {
    const { fetcher } = fakeArtifactWorker();
    const ctx = ctxWith(fetcher);
    await expect(artifacts.operations["artifacts.get"]!({ artifact_id: "nonexistent" }, ctx)).rejects.toThrow(/404/);
  });

  it("throws a clear configuration error when artifactWorker isn't bound", async () => {
    const ctx = ctxWith(undefined as unknown as Fetcher);
    delete (ctx.env as Partial<ScriptEngineEnv>).artifactWorker;
    await expect(artifacts.operations["artifacts.list"]!({}, ctx)).rejects.toThrow(/ARTIFACT_WORKER/);
  });

  it("declares paramHints naming the real required fields", () => {
    expect(artifacts.paramHints?.["artifacts.create"]).toMatch(/filename/);
    expect(artifacts.paramHints?.["artifacts.create"]).toMatch(/content/);
    expect(artifacts.paramHints?.["artifacts.get"]).toMatch(/artifact_id/);
  });
});
