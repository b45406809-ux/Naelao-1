import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import worker from "./index.js";

function fixture(options: { existing?: boolean; projectId?: string; allowedUserIds?: string[]; requiredRoleRank?: number; vectorPresent?: boolean; aiFails?: boolean } = {}) {
  const writes: Array<{ key: string; value: unknown }> = [];
  const dbCalls: Array<{ sql: string; args: unknown[] }> = [];
  const vectorUpserts: VectorizeVector[][] = [];
  const db = {
    prepare: vi.fn((sql: string) => ({
      bind: (...args: unknown[]) => {
        dbCalls.push({ sql, args });
        return {
          first: async () => {
            if (sql.includes("FROM spaces")) return { id: "space-1" };
            if (sql.includes("COUNT(*) as count FROM kb_documents")) return { count: 0 };
            if (sql.includes("SELECT id, title, chunk_count, project_id,")) return options.existing
              ? { id: "doc-1", title: "Old title", chunk_count: 1, project_id: options.projectId ?? null, required_role_rank: options.requiredRoleRank ?? 0, content_type: "text" }
              : null;
            if (sql.includes("FROM project_access")) return null;
            if (sql.includes("SELECT id, chunk_count, project_id FROM kb_documents")) return options.existing
              ? { id: "doc-1", chunk_count: 1, project_id: options.projectId ?? null }
              : null;
            if (sql.includes("SELECT * FROM kb_documents")) return { id: "doc-1", status: "indexed" };
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 1 } }),
        };
      },
    })),
    batch: vi.fn(async () => []),
  };
  const vectorize = {
    getByIds: vi.fn(async () => options.vectorPresent === false ? [] : [{
      id: "doc-1_chunk_0", values: [0.1],
      metadata: { allowed_user_ids: options.allowedUserIds ?? [], required_role_rank: options.requiredRoleRank ?? 0 },
    }]),
    deleteByIds: vi.fn(async () => undefined),
    upsert: vi.fn(async (vectors: VectorizeVector[]) => { vectorUpserts.push(vectors); return { count: vectors.length }; }),
  };
  const env = {
    ENVIRONMENT: "test", PLATFORM_SECRET: "secret", PLATFORM_DB: db,
    KB_BUCKET: {
      put: vi.fn(async (key: string, value: unknown) => { writes.push({ key, value }); }),
      list: vi.fn(async () => ({ objects: [], truncated: false })),
      delete: vi.fn(async () => undefined),
    },
    KB_VECTORS: vectorize,
    AI: { run: vi.fn(async (_model: string, input: { text: string | string[] }) => {
      if (options.aiFails) throw new Error("provider offline");
      return { data: (Array.isArray(input.text) ? input.text : [input.text]).map(() => [0.1, 0.2]) };
    }) },
  } as never;
  return { env, writes, dbCalls, vectorUpserts, vectorize };
}

async function request(path: string, method: string, body?: unknown): Promise<Request> {
  const token = await mintInternalToken("secret", "tenant-1");
  return new Request(`https://knowledge${path}`, {
    method,
    headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token,
      "x-naelao-user-id": "user-1", "x-naelao-role": "owner" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("Knowledge document lifecycle boundaries", () => {
  it("rejects malformed ACL and PDF payloads before creating document rows", async () => {
    for (const body of [
      { title: "private", content: "secret", allowed_user_ids: "user-1" },
      { title: "private", content: "%%%", content_type: "pdf" },
      { title: "private", content: "secret", required_role_rank: Number.NaN },
    ]) {
      const f = fixture();
      const response = await worker.fetch(await request("/spaces/space-1/kb/documents", "POST", body), f.env, {} as ExecutionContext);
      expect(response.status).toBe(400);
      expect(f.dbCalls.some(({ sql }) => sql.includes("INSERT INTO kb_documents"))).toBe(false);
      expect(f.writes).toHaveLength(0);
    }
  });

  it("rejects oversized JSON before parsing or writing any document state", async () => {
    const f = fixture();
    const token = await mintInternalToken("secret", "tenant-1");
    const response = await worker.fetch(new Request("https://knowledge/spaces/space-1/kb/documents", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "6500001", "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
      body: JSON.stringify({ title: "valid", content: "x" }),
    }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(413);
    expect(f.dbCalls.some(({ sql }) => sql.includes("INSERT INTO kb_documents"))).toBe(false);
    expect(f.writes).toHaveLength(0);
  });

  it("stores validated role and user ACLs on the indexed vectors", async () => {
    const f = fixture();
    const response = await worker.fetch(await request("/spaces/space-1/kb/documents", "POST", {
      title: "Private notes", content: "restricted content", required_role_rank: 30, allowed_user_ids: ["user-1"],
    }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(201);
    expect(f.vectorUpserts.flat()[0]?.metadata).toMatchObject({
      visibility: "restricted", required_role_rank: 30, allowed_roles: [], allowed_user_ids: ["user-1"],
    });
  });

  it("preserves role and user ACLs when content is reindexed", async () => {
    const f = fixture({ existing: true, allowedUserIds: ["user-1"], requiredRoleRank: 30 });
    const response = await worker.fetch(await request("/spaces/space-1/kb/documents/doc-1", "PATCH", { content: "replacement source" }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(f.vectorize.getByIds).toHaveBeenCalledWith(["doc-1_chunk_0"]);
    const updatedVector = f.vectorUpserts.flat().find((vector) => vector.id === "doc-1_chunk_0");
    expect(updatedVector?.metadata).toMatchObject({
      visibility: "restricted", required_role_rank: 30, allowed_roles: [], allowed_user_ids: ["user-1"],
    });
    const chunkInsert = f.dbCalls.find(({ sql }) => sql.includes("INSERT INTO kb_chunks"));
    expect(chunkInsert?.args).toContain(30);
  });

  it("fails closed before deleting old vectors when prior ACL metadata is unavailable", async () => {
    const f = fixture({ existing: true, vectorPresent: false, requiredRoleRank: 30 });
    const response = await worker.fetch(await request("/spaces/space-1/kb/documents/doc-1", "PATCH", { content: "replacement source" }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(503);
    expect(f.vectorize.deleteByIds).not.toHaveBeenCalled();
    expect(f.dbCalls.some(({ sql }) => sql.includes("SET status = 'processing'"))).toBe(false);
  });

  it("keeps the prior index and status when embedding fails during reindex preparation", async () => {
    const f = fixture({ existing: true, aiFails: true });
    const response = await worker.fetch(await request("/spaces/space-1/kb/documents/doc-1", "PATCH", { content: "replacement source" }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(500);
    expect(f.vectorize.deleteByIds).not.toHaveBeenCalled();
    expect(f.dbCalls.some(({ sql }) => sql.includes("SET status = 'processing'"))).toBe(false);
  });

  it("requires project membership before listing, editing, or deleting project documents", async () => {
    const cases = [
      ["/spaces/space-1/kb/documents?project_id=project-1", "GET", undefined],
      ["/spaces/space-1/kb/documents/doc-1", "PATCH", { content: "new text" }],
      ["/spaces/space-1/kb/documents/doc-1", "DELETE", undefined],
    ] as const;
    for (const [path, method, body] of cases) {
      const f = fixture({ existing: true, projectId: "project-1" });
      const response = await worker.fetch(await request(path, method, body), f.env, {} as ExecutionContext);
      expect(response.status).toBe(404);
      expect(f.vectorize.deleteByIds).not.toHaveBeenCalled();
      expect(f.dbCalls.some(({ sql }) => sql.includes("DELETE FROM kb_chunks"))).toBe(false);
    }
  });
});
