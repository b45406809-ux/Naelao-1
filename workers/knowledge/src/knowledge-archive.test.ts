import { describe, expect, it, vi } from "vitest";
import {
  exportKnowledgeArchive, previewKnowledgeArchiveRestore, restoreKnowledgeArchive,
  validateKnowledgeArchiveSnapshot, type KnowledgeArchiveChunk, type KnowledgeArchiveDocument,
} from "./knowledge-archive.js";

const scope = { tenantId: "tenant-1", spaceId: "space-1" };
const restoreId = "a".repeat(64);
const now = "2026-11-15T00:00:00.000Z";

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function archiveDocument(): Promise<KnowledgeArchiveDocument> {
  const content = "recoverable knowledge";
  const chunk: KnowledgeArchiveChunk = {
    id: "doc-1_chunk_0", tenant_id: scope.tenantId, space_id: scope.spaceId, project_id: "_space", document_id: "doc-1",
    chunk_index: 0, content, content_hash: await sha256(content), visibility: "space", required_role_rank: 30,
    source_freshness: now, heading_path: "[]", r2_key: "kb/space-1/_space/doc-1/chunk_0.txt",
    byte_start: 0, byte_end: new TextEncoder().encode(content).byteLength, line_start: 1, line_end: 1, created_at: now, deleted_at: null,
  };
  return {
    id: "doc-1", tenant_id: scope.tenantId, space_id: scope.spaceId, project_id: null, title: "Private guide",
    source_url: null, content_type: "text", status: "indexed", chunk_count: 1, required_role_rank: 30,
    allowed_user_ids_json: JSON.stringify(["user-allowed"]), created_at: now, updated_at: now,
    chunks: [chunk], objectReferences: [
      { key: "kb/space-1/_space/doc-1/chunk_0.json", etag: "json-etag", size: 2 },
      { key: "kb/space-1/_space/doc-1/chunk_0.txt", etag: "text-etag", size: new TextEncoder().encode(content).byteLength },
    ],
  };
}

function fixture(options: { documents?: unknown[]; chunks?: KnowledgeArchiveChunk[]; tombstones?: string[]; deniedLeases?: string[]; current?: Record<string, { tenant_id: string; space_id: string; archive_restore_id: string | null }> } = {}) {
  const dbCalls: Array<{ sql: string; args: unknown[] }> = [];
  const batchCalls: Array<Array<{ sql: string; args: unknown[] }>> = [];
  const docs = options.current ?? {};
  const tombstones = new Set(options.tombstones ?? []);
  const deniedLeases = new Set(options.deniedLeases ?? []);
  const leases = new Map<string, string>();
  const objects = new Map<string, { text: string; etag: string }>();
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          dbCalls.push({ sql, args });
          return {
            sql, args,
            async first() {
              if (sql.includes("FROM kb_document_deletion_operations")) return tombstones.has(String(args[0])) ? { document_id: args[0] } : null;
              if (sql.includes("FROM kb_documents WHERE id=?")) {
                const row = docs[String(args[0])];
                return row ?? null;
              }
              return null;
            },
            async all<T>() {
              if (sql.includes("FROM kb_documents d")) return { results: (options.documents ?? []) as T[] };
              if (sql.includes("FROM kb_chunks")) return { results: (options.chunks ?? []) as T[] };
              return { results: [] as T[] };
            },
            async run() {
              if (sql.includes("INSERT INTO kb_document_mutation_leases")) {
                const id = String(args[0]), token = String(args[3]);
                if (deniedLeases.has(id) || tombstones.has(id)) return { meta: { changes: 0 } };
                leases.set(id, token); return { meta: { changes: 1 } };
              }
              if (sql.includes("UPDATE kb_document_mutation_leases SET lease_until")) {
                const id = String(args[1]), token = String(args[2]);
                return { meta: { changes: leases.get(id) === token && !tombstones.has(id) ? 1 : 0 } };
              }
              if (sql.includes("DELETE FROM kb_document_mutation_leases")) {
                leases.delete(String(args[0])); return { meta: { changes: 1 } };
              }
              if (sql.includes("INSERT OR IGNORE INTO kb_documents")) {
                const id = String(args[0]);
                if (tombstones.has(id) || docs[id]) return { meta: { changes: 0 } };
                docs[id] = { tenant_id: args[2] as string, space_id: args[1] as string, archive_restore_id: args[12] as string };
                return { meta: { changes: 1 } };
              }
              if (sql.includes("UPDATE kb_documents SET status='reindex_required'")) {
                const id = String(args[0]), row = docs[id];
                if (!row || tombstones.has(id) || row.archive_restore_id !== args[3]) return { meta: { changes: 0 } };
                row.archive_restore_id = null; return { meta: { changes: 1 } };
              }
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
    async batch(statements: Array<{ sql: string; args: unknown[] }>) { batchCalls.push(statements); return statements.map(() => ({ meta: { changes: 1 } })); },
  };
  const bucket = {
    async list({ prefix = "" }: { prefix?: string } = {}) {
      return { objects: [...objects.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, etag: value.etag, size: new TextEncoder().encode(value.text).byteLength })), truncated: false };
    },
    async get(key: string) {
      const value = objects.get(key); if (!value) return null;
      const bytes = new TextEncoder().encode(value.text);
      return { etag: value.etag, size: bytes.byteLength, text: async () => value.text, arrayBuffer: async () => bytes.slice().buffer };
    },
    async head(key: string) {
      const value = objects.get(key); return value ? { etag: value.etag, size: new TextEncoder().encode(value.text).byteLength } : null;
    },
    async delete(key: string | string[]) { for (const item of Array.isArray(key) ? key : [key]) objects.delete(item); },
  };
  const vectorize = { getByIds: vi.fn(async () => []) };
  return { env: { PLATFORM_DB: db, KB_BUCKET: bucket, KB_VECTORS: vectorize } as never,
    dbCalls, batchCalls, docs, tombstones, objects, vectorize };
}

describe("Knowledge archive scope and deletion fences", () => {
  it("exports only indexed documents under a mutation lease and carries canonical ACLs", async () => {
    const document = await archiveDocument();
    const docs = [document, { ...document, id: "pending-1", status: "processing", chunk_count: 0, chunks: [], objectReferences: [] }];
    const f = fixture({ documents: docs, chunks: document.chunks });
    for (const reference of document.objectReferences) {
      f.objects.set(reference.key, { text: reference.key.endsWith(".txt") ? document.chunks[0]!.content : "{}", etag: reference.etag });
    }
    const exported = await exportKnowledgeArchive(f.env, scope);
    expect(exported.snapshot.documents).toHaveLength(1);
    expect(exported.snapshot.documents[0]?.allowed_user_ids_json).toBe(JSON.stringify(["user-allowed"]));
    expect(exported.snapshot.documents[0]?.required_role_rank).toBe(30);
    expect(exported.snapshot.omissions.nonIndexedDocuments).toBe(1);
    expect(exported.objectReferences.map(({ key }) => key)).toEqual(document.objectReferences.map(({ key }) => key));
    expect(f.vectorize.getByIds).not.toHaveBeenCalled();
    expect(f.dbCalls.some(({ sql }) => sql.includes("INSERT INTO kb_document_mutation_leases"))).toBe(true);
    expect(f.dbCalls.some(({ sql }) => sql.includes("DELETE FROM kb_document_mutation_leases"))).toBe(true);
  });

  it("fails closed on missing legacy Vectorize ACL evidence and reports a deletion-fenced lease", async () => {
    const document = await archiveDocument();
    const legacy = { ...document, allowed_user_ids_json: null };
    const denied = fixture({ documents: [legacy], chunks: document.chunks, deniedLeases: [document.id] });
    const result = await exportKnowledgeArchive(denied.env, scope);
    expect(result.snapshot.documents).toHaveLength(0);
    expect(result.snapshot.omissions.deletionFencedDocuments).toBe(1);
    const noVector = fixture({ documents: [legacy], chunks: document.chunks });
    await expect(exportKnowledgeArchive(noVector.env, scope)).rejects.toThrow("knowledge_archive_legacy_acl_unavailable");
  });

  it("rejects foreign scopes, malformed chunk coordinates and escaped R2 keys", async () => {
    const document = await archiveDocument();
    const snapshot = { version: 1, scope, documents: [document], omissions: { nonIndexedDocuments: 0, deletionFencedDocuments: 0 } };
    await expect(validateKnowledgeArchiveSnapshot(snapshot, { tenantId: "tenant-other", spaceId: scope.spaceId }))
      .rejects.toThrow("knowledge_archive_snapshot_invalid");
    await expect(validateKnowledgeArchiveSnapshot({ ...snapshot, documents: [{ ...document,
      objectReferences: [{ ...document.objectReferences[0]!, key: "kb/space-other/_space/doc-1/chunk_0.json" }] }] }, scope))
      .rejects.toThrow("knowledge_archive_object_reference_invalid");
  });

  it("preserves current rows, excludes tombstoned objects, and restores missing rows additively", async () => {
    const document = await archiveDocument();
    const snapshot = { version: 1 as const, scope, documents: [document],
      omissions: { nonIndexedDocuments: 0, deletionFencedDocuments: 0 } };
    const current = fixture({ current: { "doc-1": { tenant_id: scope.tenantId, space_id: scope.spaceId, archive_restore_id: null } } });
    const currentPreview = await previewKnowledgeArchiveRestore(current.env, snapshot, restoreId);
    expect(currentPreview.documents.preservedCurrent).toBe(1);
    expect(currentPreview.excludedObjectKeys).toHaveLength(2);
    expect((await restoreKnowledgeArchive(current.env, snapshot, restoreId)).preservedCurrentDocuments).toBe(1);
    expect(current.batchCalls).toHaveLength(0);

    const deleted = fixture({ tombstones: [document.id] });
    const deletedPreview = await previewKnowledgeArchiveRestore(deleted.env, snapshot, restoreId);
    expect(deletedPreview.documents.blockedByDeletion).toBe(1);
    expect(deletedPreview.excludedObjectKeys).toHaveLength(2);
    const deletedResult = await restoreKnowledgeArchive(deleted.env, snapshot, restoreId);
    expect(deletedResult.blockedByDeletionDocuments).toBe(1);
    expect(deleted.dbCalls.some(({ sql }) => sql.includes("INSERT OR IGNORE INTO kb_documents"))).toBe(false);

    const restored = fixture();
    for (const reference of document.objectReferences) {
      restored.objects.set(reference.key, { text: reference.key.endsWith(".txt") ? document.chunks[0]!.content : "{}", etag: "restored-etag" });
    }
    const result = await restoreKnowledgeArchive(restored.env, snapshot, restoreId);
    expect(result).toMatchObject({ restoredDocuments: 1, restoredChunks: 1, requiresReindexDocuments: 1 });
    expect(restored.batchCalls.flat().every(({ sql }) => sql.includes("NOT EXISTS (SELECT 1 FROM kb_document_deletion_operations"))).toBe(true);
    expect(restored.dbCalls.some(({ sql }) => sql.includes("status='reindex_required'"))).toBe(true);
    expect(restored.dbCalls.some(({ sql }) => sql.includes("DELETE FROM kb_document_mutation_leases"))).toBe(true);
    expect(restored.vectorize.getByIds).not.toHaveBeenCalled();
  });

  it("rechecks a deletion tombstone after preview and removes objects written for a raced restore", async () => {
    const document = await archiveDocument();
    const snapshot = { version: 1 as const, scope, documents: [document],
      omissions: { nonIndexedDocuments: 0, deletionFencedDocuments: 0 } };
    const restoring = fixture();
    const preview = await previewKnowledgeArchiveRestore(restoring.env, snapshot, restoreId);
    expect(preview.documents.willRestore).toBe(1);
    for (const reference of document.objectReferences) {
      restoring.objects.set(reference.key, { text: reference.key.endsWith(".txt") ? document.chunks[0]!.content : "{}", etag: "restored-etag" });
    }

    restoring.tombstones.add(document.id);
    const result = await restoreKnowledgeArchive(restoring.env, snapshot, restoreId);

    expect(result.blockedByDeletionDocuments).toBe(1);
    expect(restoring.objects.size).toBe(0);
    expect(restoring.dbCalls.some(({ sql }) => sql.includes("INSERT OR IGNORE INTO kb_documents"))).toBe(false);
  });
});
