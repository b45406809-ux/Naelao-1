import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import worker from "./index.js";

function fixture(options: { existing?: boolean; projectId?: string; workflowDoc?: boolean; workflowStatus?: string; reindexDoc?: boolean; reindexChunks?: Array<{ chunk_index: number; content: string; content_hash: string; deleted_at: string | null }>; queueFails?: boolean; queueAcceptThenThrow?: boolean; failFirstBucketPut?: boolean; allowedUserIds?: string[]; requiredRoleRank?: number; vectorPresent?: boolean; aiFails?: boolean; vectorUpsertFails?: boolean; spaceActive?: boolean; suspendAfterActiveCheck?: boolean; mutationLeaseUnavailable?: boolean; legacyAcl?: boolean } = {}) {
  const writes: Array<{ key: string; value: unknown }> = [];
  const dbCalls: Array<{ sql: string; args: unknown[] }> = [];
  const idempotencyClaims = new Map<string, { request_sha256: string | null; document_id: string; state: "active" | "deleted"; dispatch_state: "claimed" | "dispatching" }>();
  const documents = new Map<string, Record<string, unknown>>();
  const bucketObjects = new Set<string>();
  const queueMessages: unknown[] = [];
  const storageUsageEvents: Array<Record<string, unknown>> = [];
  const vectorUpserts: VectorizeVector[][] = [];
  let failFirstBucketPut = options.failFirstBucketPut ?? false;
  let queueAcceptThenThrow = options.queueAcceptThenThrow ?? false;
  let activeChecks = 0;
  const db = {
    prepare: vi.fn((sql: string) => ({
      bind: (...args: unknown[]) => {
        dbCalls.push({ sql, args });
        return {
          sql,
          args,
          first: async () => {
            if (sql.includes("JOIN orgs")) {
              activeChecks += 1;
              return options.spaceActive === false || (options.suspendAfterActiveCheck && activeChecks > 1) ? null : { id: "space-1" };
            }
          if (sql.includes("FROM kb_document_idempotency_requests")) {
            const key = JSON.stringify(args.slice(0, 4));
            return idempotencyClaims.get(key) ?? null;
          }
          if (sql.startsWith("SELECT id,tenant_id,space_id,project_id,title,source_url,content_type,status")) {
            const document = documents.get(String(args[0]));
            if (!document || document.tenant_id !== args[1] || document.space_id !== args[2] || document.project_id !== args[3]) return null;
            return document;
          }
            if (sql.includes("FROM spaces")) return { id: "space-1" };
            if (sql.includes("COUNT(*) as count FROM kb_documents")) return { count: 0 };
            if (sql.includes("SELECT id, title, status, chunk_count")) return options.workflowDoc
              ? { id: "doc-1", title: "Guide", status: options.workflowStatus ?? "processing", chunk_count: 2,
                  required_role_rank: options.requiredRoleRank,
                  allowed_user_ids_json: options.allowedUserIds ? JSON.stringify(options.allowedUserIds) : null }
              : null;
            if (sql.includes("SELECT id, status FROM kb_documents")) return options.workflowDoc
              ? { id: "doc-1", status: options.workflowStatus ?? "processing" }
              : null;
            if (sql.includes("SELECT id,title,project_id,status,chunk_count")) return options.reindexDoc
              ? { id: "doc-1", title: "Restored guide", project_id: null, status: "reindex_required", chunk_count: options.reindexChunks?.length ?? 0 }
              : null;
            if (sql.includes("SELECT id, title, chunk_count, project_id,")) return options.existing
              ? { id: "doc-1", title: "Old title", chunk_count: 1, project_id: options.projectId ?? null,
                  required_role_rank: options.legacyAcl ? 0 : options.requiredRoleRank ?? 0,
                  allowed_user_ids_json: options.legacyAcl ? null : options.allowedUserIds ? JSON.stringify(options.allowedUserIds) : null,
                  legacy_required_role_rank: options.requiredRoleRank ?? 0, content_type: "text" }
              : null;
            if (sql.includes("FROM project_access")) return options.workflowDoc ? { role_rank: 50, visibility: "private" } : null;
            if (sql.includes("SELECT id, chunk_count, project_id FROM kb_documents")) return options.existing
              ? { id: "doc-1", chunk_count: 1, project_id: options.projectId ?? null }
              : null;
          if (sql.includes("SELECT id, space_id, tenant_id, project_id, title, source_url, content_type, status")) {
            return documents.get(String(args[0])) ?? { id: "doc-1", status: "indexed" };
          }
            return null;
          },
          all: async () => ({ results: sql.includes("SELECT chunk_index,content,content_hash,deleted_at") ? options.reindexChunks ?? [] : [] }),
          run: async () => {
            if (options.mutationLeaseUnavailable && sql.includes("INSERT INTO kb_document_mutation_leases")) return { meta: { changes: 0 } };
            if (sql.includes("UPDATE kb_document_idempotency_requests") && sql.includes("SET dispatch_state='dispatching'")) {
              const claimKey = JSON.stringify(args.slice(0, 4));
              const claim = idempotencyClaims.get(claimKey);
              const document = claim ? documents.get(claim.document_id) : null;
              if (claim?.state === "active" && document?.status === "processing") {
                idempotencyClaims.set(claimKey, { ...claim, dispatch_state: "dispatching" });
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 0 } };
            }
            if (sql.includes("SET status = 'indexed'")) {
              const document = documents.get(String(args[3]));
              if (document) documents.set(String(args[3]), { ...document, status: "indexed", chunk_count: args[0] });
            }
            if (sql.includes("UPDATE kb_documents SET status='failed'")) {
              const document = documents.get(String(args[0]));
              if (document) documents.set(String(args[0]), { ...document, status: "failed" });
            }
            return { meta: { changes: 1 } };
          },
        };
      },
    })),
    batch: vi.fn(async (statements: Array<{ sql: string; args: unknown[] }>) => {
      if (statements[0]?.sql.includes("INSERT INTO kb_document_idempotency_requests")) {
        const claimArgs = statements[0].args;
        const claimKey = JSON.stringify(claimArgs.slice(0, 4));
        if (idempotencyClaims.has(claimKey)) return [{ meta: { changes: 0 } }, { meta: { changes: 0 } }];
        const documentArgs = statements[1]?.args ?? [];
        const documentId = String(documentArgs[0]);
        idempotencyClaims.set(claimKey, { request_sha256: String(claimArgs[4]), document_id: documentId,
          state: "active", dispatch_state: "claimed" });
        documents.set(documentId, { id: documentId, space_id: documentArgs[1], tenant_id: documentArgs[2],
          project_id: documentArgs[3], title: documentArgs[4], source_url: documentArgs[5], content_type: documentArgs[6],
          status: "processing", chunk_count: 0, created_at: documentArgs[14], updated_at: documentArgs[15] });
        return [{ meta: { changes: 1 } }, { meta: { changes: 1 } }];
      }
      if (statements[0]?.sql.includes("UPDATE kb_documents SET status = 'indexed'"))
        return statements.map(() => ({ meta: { changes: 1 } }));
      return [];
    }),
  };
  const vectorize = {
    getByIds: vi.fn(async () => options.vectorPresent === false ? [] : [{
      id: "doc-1_chunk_0", values: [0.1],
      metadata: { allowed_user_ids: options.allowedUserIds ?? [], required_role_rank: options.requiredRoleRank ?? 0 },
    }]),
    deleteByIds: vi.fn(async () => undefined),
    upsert: vi.fn(async (vectors: VectorizeVector[]) => {
      vectorUpserts.push(vectors);
      if (options.vectorUpsertFails) throw new Error("partial vector write failure");
      return { count: vectors.length };
    }),
  };
  const env = {
    ENVIRONMENT: "test", PLATFORM_SECRET: "secret", PLATFORM_DB: db,
    KB_BUCKET: {
      put: vi.fn(async (key: string, value: unknown) => {
        if (failFirstBucketPut) { failFirstBucketPut = false; throw new Error("temporary R2 outage"); }
        writes.push({ key, value }); bucketObjects.add(key);
      }),
      list: vi.fn(async () => ({ objects: [], truncated: false })),
      head: vi.fn(async (key: string) => bucketObjects.has(key) ? { key } : null),
      delete: vi.fn(async (key: string) => { bucketObjects.delete(key); }),
    },
    KB_VECTORS: vectorize,
    BILLING_WORKER: { fetch: vi.fn(async (request: Request) => {
      storageUsageEvents.push(await request.json() as Record<string, unknown>);
      return Response.json({ accepted: true });
    }) },
    EVENTS_QUEUE: { send: vi.fn(async (message: unknown) => {
      queueMessages.push(message);
      if (queueAcceptThenThrow) { queueAcceptThenThrow = false; throw new Error("queue acknowledgement lost after acceptance"); }
      if (options.queueFails) throw new Error("queue offline");
    }) },
    AI: { run: vi.fn(async (_model: string, input: { text: string | string[] }) => {
      if (options.aiFails) throw new Error("provider offline");
      return { data: (Array.isArray(input.text) ? input.text : [input.text]).map(() => [0.1, 0.2]) };
    }) },
  } as never;
  return { env, writes, dbCalls, vectorUpserts, vectorize, idempotencyClaims, documents, queueMessages, storageUsageEvents };
}

async function request(path: string, method: string, body?: unknown, addCreateIdempotencyKey = true): Promise<Request> {
  const token = await mintInternalToken("secret", "tenant-1");
  const requestBody = addCreateIdempotencyKey && method === "POST" && path === "/spaces/space-1/kb/documents"
    && body !== null && typeof body === "object" && !Array.isArray(body) && !("idempotency_key" in body)
    ? { ...body, idempotency_key: "test-idempotency-key-0001" }
    : body;
  return new Request(`https://knowledge${path}`, {
    method,
    headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token,
      "x-naelao-user-id": "user-1", "x-naelao-role": "owner" },
    ...(requestBody === undefined ? {} : { body: JSON.stringify(requestBody) }),
  });
}

describe("Knowledge document lifecycle boundaries", () => {
  it("exposes one bounded tenant-authenticated snapshot without duplicating its object reference ledger", async () => {
    const f = fixture();
    const response = await worker.fetch(await request(
      "/internal/spaces/space-1/kb/archive/export", "POST", {},
    ), f.env, {} as ExecutionContext);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ snapshot: {
      version: 1, scope: { tenantId: "tenant-1", spaceId: "space-1" }, documents: [],
    } });
    expect(f.vectorUpserts).toHaveLength(0);
  });

  it("returns verified restored chunk text for the explicit existing reindex caller without provider effects", async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("alpha"));
    const contentHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const f = fixture({ reindexDoc: true, reindexChunks: [{ chunk_index: 0, content: "alpha", content_hash: contentHash, deleted_at: null }] });
    const response = await worker.fetch(await request(
      "/spaces/space-1/kb/documents/doc-1/reindex-content", "GET",
    ), f.env, {} as ExecutionContext);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ id: "doc-1", title: "Restored guide", content: "alpha", source: "restored_indexed_chunks" });
    expect(f.vectorUpserts).toHaveLength(0);
    expect(f.writes).toHaveLength(0);
  });

  it("rejects corrupted restored chunks before returning reindex content", async () => {
    const f = fixture({ reindexDoc: true, reindexChunks: [{ chunk_index: 0, content: "tampered", content_hash: "0".repeat(64), deleted_at: null }] });
    const response = await worker.fetch(await request(
      "/spaces/space-1/kb/documents/doc-1/reindex-content", "GET",
    ), f.env, {} as ExecutionContext);

    expect(response.status).toBe(409);
    expect(f.vectorUpserts).toHaveLength(0);
  });

  it("does not reveal restored chunk text after a deletion operation takes its fence", async () => {
    const f = fixture({ reindexDoc: true, mutationLeaseUnavailable: true,
      reindexChunks: [{ chunk_index: 0, content: "private", content_hash: "0".repeat(64), deleted_at: null }] });
    const response = await worker.fetch(await request(
      "/spaces/space-1/kb/documents/doc-1/reindex-content", "GET",
    ), f.env, {} as ExecutionContext);

    expect(response.status).toBe(410);
    expect(f.dbCalls.some(({ sql }) => sql.includes("SELECT chunk_index,content,content_hash,deleted_at"))).toBe(false);
  });

  it("accepts workflow chunk batches through the tenant-HMAC internal API", async () => {
    const f = fixture({ workflowDoc: true });
    const response = await worker.fetch(await request(
      "/internal/spaces/space-1/kb/documents/doc-1/ingest-chunks", "POST", {
        projectId: "project-1", chunks: ["alpha beta", "gamma"], chunkOffset: 0, byteOffset: 0, lineOffset: 1,
      },
    ), f.env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "doc-1", chunk_count: 2 });
    expect(f.vectorUpserts.flat().map((vector) => vector.id)).toEqual(["doc-1_chunk_0", "doc-1_chunk_1"]);
    expect(f.dbCalls.some(({ sql, args }) => sql.includes("INSERT INTO kb_chunks") && args[2] === "space-1" && args[3] === "project-1")).toBe(true);
    expect(f.writes.map(({ key }) => key)).toEqual([
      "kb/space-1/project-1/doc-1/chunk_0.json", "kb/space-1/project-1/doc-1/chunk_0.txt",
      "kb/space-1/project-1/doc-1/chunk_1.json", "kb/space-1/project-1/doc-1/chunk_1.txt",
    ]);
  });

  it("stops internal workflow writes after the tenant or space is suspended", async () => {
    const f = fixture({ workflowDoc: true, spaceActive: false });
    const response = await worker.fetch(await request(
      "/internal/spaces/space-1/kb/documents/doc-1/ingest-chunks", "POST", {
        projectId: "project-1", chunks: ["must not persist"], chunkOffset: 0, byteOffset: 0, lineOffset: 1,
      },
    ), f.env, {} as ExecutionContext);

    expect(response.status).toBe(404);
    expect(f.vectorUpserts).toHaveLength(0);
    expect(f.writes).toHaveLength(0);
    expect(f.dbCalls.some(({ sql }) => sql.includes("INSERT INTO kb_chunks"))).toBe(false);
  });

  it("rechecks Space activity after chunk embeddings before persisting chunks", async () => {
    const f = fixture({ workflowDoc: true, suspendAfterActiveCheck: true });
    const response = await worker.fetch(await request(
      "/internal/spaces/space-1/kb/documents/doc-1/ingest-chunks", "POST", {
        projectId: "project-1", chunks: ["must not persist"], chunkOffset: 0, byteOffset: 0, lineOffset: 1,
      },
    ), f.env, {} as ExecutionContext);

    expect(response.status).toBe(404);
    expect(f.writes).toHaveLength(0);
    expect(f.vectorUpserts).toHaveLength(0);
    expect(f.dbCalls.some(({ sql }) => sql.includes("INSERT INTO kb_chunks"))).toBe(false);
  });

  it("rejects queued workflow chunks after the document deletion fence wins", async () => {
    const f = fixture({ workflowDoc: true, mutationLeaseUnavailable: true });
    const response = await worker.fetch(await request(
      "/internal/spaces/space-1/kb/documents/doc-1/ingest-chunks", "POST", {
        projectId: "project-1", chunks: ["must not persist"], chunkOffset: 0, byteOffset: 0, lineOffset: 1,
      },
    ), f.env, {} as ExecutionContext);

    expect(response.status).toBe(410);
    expect(f.writes).toHaveLength(0);
    expect(f.vectorUpserts).toHaveLength(0);
    expect(f.dbCalls.some(({ sql }) => sql.includes("INSERT INTO kb_chunks"))).toBe(false);
  });

  it("preserves restrictive ACLs through workflow chunk ingestion", async () => {
    const f = fixture({ workflowDoc: true });
    const response = await worker.fetch(await request(
      "/internal/spaces/space-1/kb/documents/doc-1/ingest-chunks", "POST", {
        projectId: "project-1", chunks: ["restricted content"], chunkOffset: 0, byteOffset: 0, lineOffset: 1,
        requiredRoleRank: 40, allowedUserIds: ["user-special"],
      },
    ), f.env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(f.vectorUpserts.flat()[0]?.metadata).toMatchObject({
      visibility: "restricted", required_role_rank: 40, allowed_roles: [], allowed_user_ids: ["user-special"],
    });
    expect(f.dbCalls.some(({ sql, args }) => sql.includes("INSERT INTO kb_chunks") && args[9] === 40)).toBe(true);
  });

  it("uses persisted D1 ACLs instead of queued ACL fields for new workflow documents", async () => {
    const f = fixture({ workflowDoc: true, requiredRoleRank: 40, allowedUserIds: ["user-owner"] });
    const response = await worker.fetch(await request(
      "/internal/spaces/space-1/kb/documents/doc-1/ingest-chunks", "POST", {
        projectId: "project-1", chunks: ["restricted content"], chunkOffset: 0, byteOffset: 0, lineOffset: 1,
        requiredRoleRank: 0, allowedUserIds: [],
      },
    ), f.env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(f.vectorUpserts.flat()[0]?.metadata).toMatchObject({
      required_role_rank: 40, allowed_roles: [], allowed_user_ids: ["user-owner"],
    });
  });

  it("stages large project documents and enqueues the workflow with their access policy", async () => {
    const f = fixture({ workflowDoc: true });
    const content = "safe content ".repeat(81_000);
    const response = await worker.fetch(await request("/spaces/space-1/kb/documents", "POST", {
      title: "Large guide", content, project_id: "project-1", required_role_rank: 30, allowed_user_ids: ["user-special"],
    }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(202);
    const result = await response.json() as { id: string; status: string; ingestion: string };
    expect(result).toMatchObject({ status: "processing", ingestion: "queued" });
    const key = `staging/tenant-1/space-1/project-1/${result.id}/original`;
    expect(f.writes).toContainEqual(expect.objectContaining({ key }));
    expect((f.env as unknown as { EVENTS_QUEUE: { send: ReturnType<typeof vi.fn> } }).EVENTS_QUEUE.send)
      .toHaveBeenCalledWith(expect.objectContaining({
        type: "kb.ingest", docId: result.id, spaceId: "space-1", tenantId: "tenant-1",
        projectId: "project-1", r2Key: key, requiredRoleRank: 30, allowedUserIds: ["user-special"],
      }));
    const insert = f.dbCalls.find(({ sql }) => sql.includes("INSERT INTO kb_documents"));
    expect(insert?.sql).toContain("allowed_user_ids_json");
    expect(insert?.args).toContain(JSON.stringify(["user-special"]));
    expect(insert?.args).toContain(30);
  });

  it("requires a client idempotency key for every document create", async () => {
    const f = fixture();
    const response = await worker.fetch(await request("/spaces/space-1/kb/documents", "POST", {
      title: "Guide", content: "safe content",
    }, false), f.env, {} as ExecutionContext);
    expect(response.status).toBe(400);
    expect(f.dbCalls.some(({ sql }) => sql.includes("INSERT INTO kb_documents"))).toBe(false);
  });

  it("keeps a deleted request key tombstoned so the same key cannot recreate the document", async () => {
    const f = fixture();
    const key = "deleted-request-key-0001";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
    const keyHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    f.idempotencyClaims.set(JSON.stringify(["tenant-1", "space-1", "", keyHash]), {
      request_sha256: null, document_id: "deleted-doc", state: "deleted", dispatch_state: "dispatching",
    });
    const response = await worker.fetch(await request("/spaces/space-1/kb/documents", "POST", {
      title: "Guide", content: "safe content", idempotency_key: key,
    }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ error_code: "knowledge_create_request_deleted" });
    expect(f.documents.size).toBe(0);
    expect(f.vectorUpserts).toHaveLength(0);
  });

  it("returns the same indexed document on an exact sync retry without duplicate effects", async () => {
    const f = fixture();
    const body = { title: "Guide", content: "safe content", idempotency_key: "sync-request-key-0001" };
    const first = await worker.fetch(await request("/spaces/space-1/kb/documents", "POST", body), f.env, {} as ExecutionContext);
    expect(first.status).toBe(201);
    const firstDocument = await first.json() as { id: string };
    const writesAfterFirst = f.writes.length;
    const usageEventsAfterFirst = f.storageUsageEvents.length;
    const ai = (f.env as unknown as { AI: { run: ReturnType<typeof vi.fn> } }).AI.run;
    const second = await worker.fetch(await request("/spaces/space-1/kb/documents", "POST", body), f.env, {} as ExecutionContext);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ id: firstDocument.id, status: "indexed" });
    expect(f.documents.size).toBe(1);
    expect(ai).toHaveBeenCalledTimes(1);
    expect(f.vectorUpserts).toHaveLength(1);
    expect(f.writes).toHaveLength(writesAfterFirst);
    expect(f.storageUsageEvents).toHaveLength(usageEventsAfterFirst);
  });

  it("rejects idempotency-key reuse after content or ACL changes before indexing", async () => {
    const f = fixture();
    const body = { title: "Guide", content: "safe content", idempotency_key: "sync-request-key-0002" };
    const first = await worker.fetch(await request("/spaces/space-1/kb/documents", "POST", body), f.env, {} as ExecutionContext);
    expect(first.status).toBe(201);
    const ai = (f.env as unknown as { AI: { run: ReturnType<typeof vi.fn> } }).AI.run;
    const effects = { writes: f.writes.length, vectors: f.vectorUpserts.length, ai: ai.mock.calls.length };
    for (const changed of [
      { ...body, content: "different content" },
      { ...body, allowed_user_ids: ["user-2"] },
    ]) {
      const response = await worker.fetch(await request("/spaces/space-1/kb/documents", "POST", changed), f.env, {} as ExecutionContext);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error_code: "knowledge_idempotency_key_reused" });
    }
    expect(f.documents.size).toBe(1);
    expect(f.writes).toHaveLength(effects.writes);
    expect(f.vectorUpserts).toHaveLength(effects.vectors);
    expect(ai).toHaveBeenCalledTimes(effects.ai);
  });

  it("converges concurrent sync creates with the same key on one document and one embedding", async () => {
    const f = fixture();
    const body = { title: "Guide", content: "safe content", idempotency_key: "sync-request-key-0003" };
    const requests = await Promise.all([
      request("/spaces/space-1/kb/documents", "POST", body),
      request("/spaces/space-1/kb/documents", "POST", body),
    ]);
    const responses = await Promise.all(requests.map((req) => worker.fetch(req, f.env, {} as ExecutionContext)));
    const results = await Promise.all(responses.map(async (response) => ({ status: response.status, body: await response.json() as { id: string } })));
    expect(new Set(results.map((result) => result.body.id)).size).toBe(1);
    expect(results.map((result) => result.status).sort()).toEqual([201, 202]);
    expect(f.documents.size).toBe(1);
    expect((f.env as unknown as { AI: { run: ReturnType<typeof vi.fn> } }).AI.run).toHaveBeenCalledTimes(1);
    expect(f.vectorUpserts).toHaveLength(1);
  });

  it("resumes a claimed large upload after staging failure with the same document ID", async () => {
    const f = fixture({ workflowDoc: true, failFirstBucketPut: true });
    const body = { title: "Large guide", content: "safe content ".repeat(81_000), project_id: "project-1",
      idempotency_key: "queued-request-key-0001" };
    const first = await worker.fetch(await request("/spaces/space-1/kb/documents", "POST", body), f.env, {} as ExecutionContext);
    expect(first.status).toBe(503);
    expect(await first.json()).toMatchObject({ error_code: "ingestion_stage_unavailable" });
    expect(f.queueMessages).toHaveLength(0);
    const claim = [...f.idempotencyClaims.values()][0];
    expect(claim?.dispatch_state).toBe("claimed");
    const second = await worker.fetch(await request("/spaces/space-1/kb/documents", "POST", body), f.env, {} as ExecutionContext);
    expect(second.status).toBe(202);
    const result = await second.json() as { id: string };
    expect(result.id).toBe(claim?.document_id);
    expect(f.queueMessages).toHaveLength(1);
    expect(f.writes.filter(({ key }) => key.startsWith("staging/")).map(({ key }) => key)).toEqual([
      `staging/tenant-1/space-1/project-1/${result.id}/original`,
    ]);
  });

  it("retries an ambiguous queue acknowledgement with the same document and staged payload", async () => {
    const f = fixture({ workflowDoc: true, queueAcceptThenThrow: true });
    const body = { title: "Large guide", content: "safe content ".repeat(81_000), project_id: "project-1",
      idempotency_key: "queued-request-key-0002" };
    const first = await worker.fetch(await request("/spaces/space-1/kb/documents", "POST", body), f.env, {} as ExecutionContext);
    expect(first.status).toBe(503);
    expect(await first.json()).toMatchObject({ error_code: "ingestion_dispatch_uncertain" });
    const claim = [...f.idempotencyClaims.values()][0];
    expect(claim?.dispatch_state).toBe("dispatching");
    const stageWrites = f.writes.filter(({ key }) => key.startsWith("staging/")).length;
    const storageEvents = [...f.storageUsageEvents];
    const second = await worker.fetch(await request("/spaces/space-1/kb/documents", "POST", body), f.env, {} as ExecutionContext);
    expect(second.status).toBe(202);
    expect((await second.json() as { id: string }).id).toBe(claim?.document_id);
    expect(f.queueMessages).toHaveLength(2);
    expect((f.queueMessages as Array<{ docId: string }>).map((message) => message.docId)).toEqual([claim?.document_id, claim?.document_id]);
    expect(f.writes.filter(({ key }) => key.startsWith("staging/")).length).toBe(stageWrites);
    expect(f.storageUsageEvents.length).toBe(storageEvents.length + 1);
    expect(new Set(f.storageUsageEvents.map((event) => event.idempotency_key)).size).toBe(1);
    expect(f.storageUsageEvents.map((event) => event.quantity)).toEqual([storageEvents[0]?.quantity, storageEvents[0]?.quantity]);
    expect((f.env as unknown as { AI: { run: ReturnType<typeof vi.fn> } }).AI.run).not.toHaveBeenCalled();
  });

  it("does not stage or enqueue a large document after deletion fencing denies its mutation lease", async () => {
    const f = fixture({ workflowDoc: true, mutationLeaseUnavailable: true });
    const response = await worker.fetch(await request("/spaces/space-1/kb/documents", "POST", {
      title: "Large guide", content: "safe content ".repeat(81_000), project_id: "project-1",
    }), f.env, {} as ExecutionContext);

    expect(response.status).toBe(410);
    expect(f.writes).toHaveLength(0);
    expect((f.env as unknown as { EVENTS_QUEUE: { send: ReturnType<typeof vi.fn> } }).EVENTS_QUEUE.send).not.toHaveBeenCalled();
  });

  it("stops content reindexing when deletion wins mutation lease admission", async () => {
    const f = fixture({ existing: true, mutationLeaseUnavailable: true });
    const response = await worker.fetch(await request("/spaces/space-1/kb/documents/doc-1", "PATCH", {
      content: "replacement content",
    }), f.env, {} as ExecutionContext);

    expect(response.status).toBe(410);
    expect(f.writes).toHaveLength(0);
    expect(f.vectorize.deleteByIds).not.toHaveBeenCalled();
    expect(f.vectorUpserts).toHaveLength(0);
  });

  it("stops synchronous document ingestion when deletion fencing denies its mutation lease", async () => {
    const f = fixture({ mutationLeaseUnavailable: true });
    const response = await worker.fetch(await request("/spaces/space-1/kb/documents", "POST", {
      title: "Guide", content: "new content",
    }), f.env, {} as ExecutionContext);

    expect(response.status).toBe(410);
    expect(f.writes).toHaveLength(0);
    expect(f.vectorUpserts).toHaveLength(0);
  });

  it("preserves staged data and the idempotency claim when queue acceptance is uncertain", async () => {
    const f = fixture({ workflowDoc: true, queueFails: true });
    const response = await worker.fetch(await request("/spaces/space-1/kb/documents", "POST", {
      title: "Large guide", content: "safe content ".repeat(81_000), project_id: "project-1",
    }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(503);
    const stagingWrite = f.writes.find(({ key }) => key.startsWith("staging/"));
    expect(stagingWrite).toBeDefined();
    expect((f.env as unknown as { KB_BUCKET: { delete: ReturnType<typeof vi.fn> } }).KB_BUCKET.delete)
      .not.toHaveBeenCalled();
    expect(f.idempotencyClaims.size).toBe(1);
    expect([...f.idempotencyClaims.values()][0]?.dispatch_state).toBe("dispatching");
    expect(f.documents.size).toBe(1);
  });

  it("updates workflow document status only for the matching tenant, space, and project", async () => {
    const f = fixture({ workflowDoc: true });
    const response = await worker.fetch(await request(
      "/internal/spaces/space-1/kb/documents/doc-1/status", "PUT", { status: "processing", project_id: "project-1" },
    ), f.env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "doc-1", status: "processing" });
    expect(f.dbCalls.some(({ sql, args }) => sql.includes("UPDATE kb_documents SET status") &&
      args[2] === "doc-1" && args[3] === "space-1" && args[4] === "tenant-1" && args[5] === "project-1")).toBe(true);
  });

  it("rejects workflow chunk batches for unknown docs and malformed oversized input", async () => {
    const missing = fixture();
    const missingResponse = await worker.fetch(await request(
      "/internal/spaces/space-1/kb/documents/doc-1/ingest-chunks", "POST", {
        projectId: "project-1", chunks: ["one"], chunkOffset: 0, byteOffset: 0, lineOffset: 1,
      },
    ), missing.env, {} as ExecutionContext);
    expect(missingResponse.status).toBe(404);
    expect(missing.vectorUpserts).toHaveLength(0);

    const valid = fixture({ workflowDoc: true });
    const invalidResponse = await worker.fetch(await request(
      "/internal/spaces/space-1/kb/documents/doc-1/ingest-chunks", "POST", {
        projectId: "project-1", chunks: ["x".repeat(10 * 1024 + 1)], chunkOffset: 0, byteOffset: 0, lineOffset: 1,
      },
    ), valid.env, {} as ExecutionContext);
    expect(invalidResponse.status).toBe(400);
    expect(valid.vectorUpserts).toHaveLength(0);
  });

  it("requires an internal token on workflow-only document status routes", async () => {
    const f = fixture({ workflowDoc: true });
    const response = await worker.fetch(new Request("https://knowledge/internal/spaces/space-1/kb/documents/doc-1/status", {
      method: "PUT", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-1" },
      body: JSON.stringify({ status: "processing", project_id: "project-1" }),
    }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(403);
    expect(f.dbCalls).toHaveLength(0);
  });

  it.each([null, [], "invalid"])("returns 400 for non-object internal workflow payloads", async (body) => {
    const f = fixture({ workflowDoc: true });
    const response = await worker.fetch(await request(
      "/internal/spaces/space-1/kb/documents/doc-1/status", "PUT", body,
    ), f.env, {} as ExecutionContext);
    expect(response.status).toBe(400);
    expect(f.dbCalls).toHaveLength(1); // Tenant/space activity gate runs before the handler parses the body.
    expect(f.dbCalls[0]?.sql).toContain("JOIN orgs");
  });

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

  it("rejects empty or whitespace-only documents before staging them", async () => {
    for (const content of ["", " \n\t "]) {
      const f = fixture();
      const response = await worker.fetch(await request("/spaces/space-1/kb/documents", "POST", { title: "Blank", content }), f.env, {} as ExecutionContext);
      expect(response.status).toBe(400);
      expect(f.writes).toHaveLength(0);
      expect((f.env as unknown as { EVENTS_QUEUE: { send: ReturnType<typeof vi.fn> } }).EVENTS_QUEUE.send).not.toHaveBeenCalled();
    }
  });

  it("rejects oversized JSON before parsing or writing any document state", async () => {
    const f = fixture();
    const token = await mintInternalToken("secret", "tenant-1");
    const response = await worker.fetch(new Request("https://knowledge/spaces/space-1/kb/documents", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "14000001", "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
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

  it("records the expected vector count before an upsert can partially fail", async () => {
    const f = fixture({ vectorUpsertFails: true });
    const response = await worker.fetch(await request("/spaces/space-1/kb/documents", "POST", {
      title: "Retry cleanup", content: "This is a document for cleanup after a partial vector write.",
    }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(500);
    const countUpdate = f.dbCalls.find(({ sql }) => sql.includes("SET chunk_count = ? WHERE id = ? AND status IN"));
    expect(countUpdate?.args[0]).toBe(1);
    expect(f.vectorize.upsert).toHaveBeenCalledTimes(1);
    expect(f.dbCalls.some(({ sql }) => sql.includes("SET status = 'failed'"))).toBe(true);
  });

  it("preserves role and user ACLs when content is reindexed", async () => {
    const f = fixture({ existing: true, allowedUserIds: ["user-1"], requiredRoleRank: 30 });
    const response = await worker.fetch(await request("/spaces/space-1/kb/documents/doc-1", "PATCH", { content: "replacement source" }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(f.vectorize.getByIds).not.toHaveBeenCalled();
    const updatedVector = f.vectorUpserts.flat().find((vector) => vector.id === "doc-1_chunk_0");
    expect(updatedVector?.metadata).toMatchObject({
      visibility: "restricted", required_role_rank: 30, allowed_roles: [], allowed_user_ids: ["user-1"],
    });
    const chunkInsert = f.dbCalls.find(({ sql }) => sql.includes("INSERT INTO kb_chunks"));
    expect(chunkInsert?.args).toContain(30);
  });

  it("continues to recover legacy ACLs from Vectorize when the D1 policy is unknown", async () => {
    const f = fixture({ existing: true, legacyAcl: true, allowedUserIds: ["user-legacy"], requiredRoleRank: 30 });
    const response = await worker.fetch(await request("/spaces/space-1/kb/documents/doc-1", "PATCH", { content: "replacement source" }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(f.vectorize.getByIds).toHaveBeenCalledWith(["doc-1_chunk_0"]);
    expect(f.vectorUpserts.flat().find((vector) => vector.id === "doc-1_chunk_0")?.metadata).toMatchObject({
      allowed_user_ids: ["user-legacy"], required_role_rank: 30,
    });
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
