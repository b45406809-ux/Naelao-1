import { acquireKnowledgeDocumentMutationLease, releaseKnowledgeDocumentMutationLease, renewKnowledgeDocumentMutationLease } from "./document-deletion.js";

export interface KnowledgeArchiveObjectReference { key: string; etag: string; size: number; }
export interface KnowledgeArchiveChunk {
  id: string; tenant_id: string; space_id: string; project_id: string; document_id: string;
  chunk_index: number; content: string; content_hash: string; visibility: string; required_role_rank: number;
  source_freshness: string; heading_path: string; r2_key: string; byte_start: number; byte_end: number;
  line_start: number; line_end: number; created_at: string; deleted_at: string | null;
}
export interface KnowledgeArchiveDocument {
  id: string; tenant_id: string; space_id: string; project_id: string | null; title: string; source_url: string | null;
  content_type: string; status: "indexed"; chunk_count: number; required_role_rank: number;
  allowed_user_ids_json: string; created_at: string; updated_at: string;
  source_sha256?: string | null; source_file_name?: string | null; parser_version?: string | null;
  parser_output_sha256?: string | null; approved_content_sha256?: string | null;
  source_adapter?: "manual" | "website" | "connector"; source_revision?: number;
  source_content_sha256?: string | null; source_connection_ref?: string | null; source_grant_revision?: number | null;
  source_state?: "current" | "stale" | "revoked" | "unsupported";
  chunks: KnowledgeArchiveChunk[]; objectReferences: KnowledgeArchiveObjectReference[];
}
export interface KnowledgeArchiveSnapshot {
  version: 1; scope: { tenantId: string; spaceId: string }; documents: KnowledgeArchiveDocument[];
  omissions: { nonIndexedDocuments: number; deletionFencedDocuments: number };
}
export interface KnowledgeArchiveBindings {
  PLATFORM_DB: D1Database; KB_BUCKET: R2Bucket; KB_VECTORS: VectorizeIndex;
}

const MAX_DOCUMENTS = 500;
const MAX_CHUNKS = 2_000;
const MAX_D1_BYTES = 3 * 1024 * 1024;
const MAX_OBJECTS = 5_000;
const MAX_OBJECT_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_OBJECT_BYTES = 64 * 1024 * 1024;
const CHUNK_COLUMNS = `id,tenant_id,space_id,project_id,document_id,chunk_index,content,content_hash,visibility,
  required_role_rank,source_freshness,heading_path,r2_key,byte_start,byte_end,line_start,line_end,created_at,deleted_at`;

async function contentHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sourceHash(value: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

function parseAcl(value: unknown): string[] {
  if (typeof value !== "string") throw new Error("knowledge_archive_acl_invalid");
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("knowledge_archive_acl_invalid"); }
  if (!Array.isArray(parsed) || parsed.length > 100 || parsed.some((id) => !validId(id))) throw new Error("knowledge_archive_acl_invalid");
  return [...new Set(parsed as string[])];
}

function parseLegacyVectorAcl(vector: VectorizeVector | undefined): string[] {
  if (!vector) throw new Error("knowledge_archive_legacy_acl_unavailable");
  const value = vector.metadata?.allowed_user_ids;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100 || value.some((id) => !validId(id))) throw new Error("knowledge_archive_acl_invalid");
  return [...new Set(value as string[])];
}

function objectKeyAllowed(key: string, spaceId: string, projectId: string | null, documentId: string): boolean {
  const prefix = `kb/${spaceId}/${projectId ?? "_space"}/${documentId}/`;
  if (!key.startsWith(prefix)) return false;
  const leaf = key.slice(prefix.length);
  return leaf === "original" || /^chunk_[0-9]{1,5}\.(?:json|txt)$/.test(leaf);
}

export async function exportKnowledgeArchive(
  env: KnowledgeArchiveBindings,
  scope: { tenantId: string; spaceId: string },
): Promise<{ snapshot: KnowledgeArchiveSnapshot; objectReferences: KnowledgeArchiveObjectReference[] }> {
  const { results: rows } = await env.PLATFORM_DB.prepare(`SELECT d.id,d.tenant_id,d.space_id,d.project_id,d.title,d.source_url,
    d.content_type,d.status,d.chunk_count,d.required_role_rank,d.allowed_user_ids_json,d.source_sha256,d.source_file_name,
    d.parser_version,d.parser_output_sha256,d.approved_content_sha256,d.source_adapter,d.source_revision,
    d.source_content_sha256,d.source_connection_ref,d.source_grant_revision,d.source_state,d.created_at,d.updated_at
    FROM kb_documents d WHERE d.tenant_id=? AND d.space_id=? AND NOT EXISTS
      (SELECT 1 FROM kb_document_deletion_operations x WHERE x.document_id=d.id)
    ORDER BY d.id LIMIT ?`).bind(scope.tenantId, scope.spaceId, MAX_DOCUMENTS + 1)
    .all<Record<string, unknown>>();
  if (rows.length > MAX_DOCUMENTS) throw new Error("knowledge_archive_document_limit_exceeded");
  const documents: KnowledgeArchiveDocument[] = [];
  const allReferences: KnowledgeArchiveObjectReference[] = [];
  const seenKeys = new Set<string>();
  let totalChunks = 0, totalD1Bytes = 0, totalObjectBytes = 0, nonIndexedDocuments = 0, deletionFencedDocuments = 0;
  for (const row of rows) {
    if (!validId(row.id) || row.tenant_id !== scope.tenantId || row.space_id !== scope.spaceId
      || row.project_id !== null && !validId(row.project_id)) throw new Error("knowledge_archive_document_scope_invalid");
    if (row.status !== "indexed") { nonIndexedDocuments++; continue; }
    const documentId = row.id;
    const token = await acquireKnowledgeDocumentMutationLease(env.PLATFORM_DB, {
      documentId, tenantId: scope.tenantId, spaceId: scope.spaceId,
    });
    if (!token) { deletionFencedDocuments++; continue; }
    try {
      const { results: chunks } = await env.PLATFORM_DB.prepare(`SELECT ${CHUNK_COLUMNS} FROM kb_chunks
        WHERE tenant_id=? AND space_id=? AND document_id=? AND deleted_at IS NULL ORDER BY chunk_index`)
        .bind(scope.tenantId, scope.spaceId, documentId).all<KnowledgeArchiveChunk>();
      if (chunks.length !== row.chunk_count || chunks.length > MAX_CHUNKS - totalChunks
        || chunks.some((chunk, index) => chunk.chunk_index !== index || chunk.tenant_id !== scope.tenantId
          || chunk.space_id !== scope.spaceId || chunk.document_id !== documentId
          || chunk.project_id !== (row.project_id ?? "_space") || chunk.deleted_at !== null
          || !validId(chunk.id) || !validId(chunk.r2_key) || !/^[a-f0-9]{64}$/.test(chunk.content_hash))) {
        throw new Error("knowledge_archive_chunk_set_invalid");
      }
      let roleRank = Number.isSafeInteger(row.required_role_rank) ? Number(row.required_role_rank) : 0;
      for (const chunk of chunks) {
        if (!Number.isSafeInteger(chunk.required_role_rank) || chunk.required_role_rank < 0 || chunk.required_role_rank > 50) {
          throw new Error("knowledge_archive_role_rank_invalid");
        }
        roleRank = Math.max(roleRank, chunk.required_role_rank);
      }
      const acl = row.allowed_user_ids_json === null
        ? parseLegacyVectorAcl(chunks.length ? (await env.KB_VECTORS.getByIds([`${documentId}_chunk_0`]))
          .find((vector) => vector.id === `${documentId}_chunk_0`) : undefined)
        : parseAcl(row.allowed_user_ids_json);
      const prefix = `kb/${scope.spaceId}/${row.project_id ?? "_space"}/${documentId}/`;
      let cursor: string | undefined;
      const references: KnowledgeArchiveObjectReference[] = [];
      do {
        const page = await env.KB_BUCKET.list({ prefix, ...(cursor ? { cursor } : {}), limit: 1000 });
        for (const object of page.objects) {
          if (!objectKeyAllowed(object.key, scope.spaceId, row.project_id as string | null, documentId)
            || !object.etag || !Number.isSafeInteger(object.size) || object.size < 0 || object.size > MAX_OBJECT_BYTES
            || seenKeys.has(object.key)) throw new Error("knowledge_archive_object_reference_invalid");
          seenKeys.add(object.key);
          totalObjectBytes += object.size;
          if (totalObjectBytes > MAX_TOTAL_OBJECT_BYTES || allReferences.length + references.length >= MAX_OBJECTS) {
            throw new Error("knowledge_archive_object_limit_exceeded");
          }
          references.push({ key: object.key, etag: object.etag, size: object.size });
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      const requiredChunkObjects = chunks.flatMap((chunk) => {
        const match = new RegExp(`^${documentId}_chunk_([0-9]+)$`).exec(chunk.id);
        if (!match) throw new Error("knowledge_archive_chunk_set_invalid");
        const index = Number(match[1]);
        return [`${prefix}chunk_${index}.json`, `${prefix}chunk_${index}.txt`];
      });
      if (requiredChunkObjects.some((key) => !references.some((reference) => reference.key === key))) {
        throw new Error("knowledge_archive_chunk_objects_incomplete");
      }
      if (typeof row.source_sha256 === "string") {
        const source = await env.KB_BUCKET.get(`${prefix}original`);
        if (!/^[a-f0-9]{64}$/.test(row.source_sha256) || !source
          || await sourceHash(await source.arrayBuffer()) !== row.source_sha256) {
          throw new Error("knowledge_archive_pdf_source_hash_mismatch");
        }
      }
      for (const chunk of chunks) {
        const citationKey = `${prefix}chunk_${chunk.chunk_index}.txt`;
        const citation = await env.KB_BUCKET.get(citationKey);
        if (!citation) throw new Error("knowledge_archive_chunk_object_mismatch");
        const citationText = await citation.text();
        if (citation.size !== new TextEncoder().encode(chunk.content).byteLength
          || await contentHash(citationText) !== chunk.content_hash || citationText !== chunk.content) {
          throw new Error("knowledge_archive_chunk_object_mismatch");
        }
      }
      if (!await renewKnowledgeDocumentMutationLease(env.PLATFORM_DB, documentId, token)) {
        deletionFencedDocuments++;
        continue;
      }
      const archivedDocument: KnowledgeArchiveDocument = {
        id: documentId, tenant_id: scope.tenantId, space_id: scope.spaceId,
        project_id: row.project_id as string | null, title: String(row.title), source_url: row.source_url as string | null,
        content_type: String(row.content_type), status: "indexed", chunk_count: chunks.length, required_role_rank: roleRank,
        allowed_user_ids_json: JSON.stringify(acl), created_at: String(row.created_at), updated_at: String(row.updated_at),
        source_sha256: typeof row.source_sha256 === "string" ? row.source_sha256 : null,
        source_file_name: typeof row.source_file_name === "string" ? row.source_file_name : null,
        parser_version: typeof row.parser_version === "string" ? row.parser_version : null,
        parser_output_sha256: typeof row.parser_output_sha256 === "string" ? row.parser_output_sha256 : null,
        approved_content_sha256: typeof row.approved_content_sha256 === "string" ? row.approved_content_sha256 : null,
        source_adapter: row.source_adapter === "website" || row.source_adapter === "connector" ? row.source_adapter : "manual",
        source_revision: Number.isSafeInteger(row.source_revision) && Number(row.source_revision) >= 1 ? Number(row.source_revision) : 1,
        source_content_sha256: typeof row.source_content_sha256 === "string" ? row.source_content_sha256 : null,
        source_connection_ref: typeof row.source_connection_ref === "string" ? row.source_connection_ref : null,
        source_grant_revision: Number.isSafeInteger(row.source_grant_revision) && Number(row.source_grant_revision) >= 1
          ? Number(row.source_grant_revision) : null,
        source_state: row.source_state === "stale" || row.source_state === "revoked" || row.source_state === "unsupported"
          ? row.source_state : "current",
        chunks, objectReferences: references,
      };
      totalChunks += chunks.length;
      totalD1Bytes += new TextEncoder().encode(JSON.stringify(archivedDocument)).byteLength;
      if (totalD1Bytes > MAX_D1_BYTES) throw new Error("knowledge_archive_d1_limit_exceeded");
      documents.push(archivedDocument);
      allReferences.push(...references);
    } finally {
      await releaseKnowledgeDocumentMutationLease(env.PLATFORM_DB, documentId, token);
    }
  }
  return {
    snapshot: { version: 1, scope, documents, omissions: { nonIndexedDocuments, deletionFencedDocuments } },
    objectReferences: allReferences,
  };
}

export async function validateKnowledgeArchiveSnapshot(
  value: unknown,
  expected: { tenantId: string; spaceId: string },
): Promise<KnowledgeArchiveSnapshot> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("knowledge_archive_snapshot_invalid");
  const snapshot = value as Partial<KnowledgeArchiveSnapshot>;
  if (snapshot.version !== 1 || !snapshot.scope || snapshot.scope.tenantId !== expected.tenantId
    || snapshot.scope.spaceId !== expected.spaceId || !Array.isArray(snapshot.documents)
    || snapshot.documents.length > MAX_DOCUMENTS || !snapshot.omissions
    || ![snapshot.omissions.nonIndexedDocuments, snapshot.omissions.deletionFencedDocuments]
      .every((count) => Number.isSafeInteger(count) && Number(count) >= 0)) throw new Error("knowledge_archive_snapshot_invalid");
  const ids = new Set<string>(), keys = new Set<string>();
  let totalChunks = 0, totalD1Bytes = 0, totalObjectBytes = 0, totalObjects = 0;
  for (const document of snapshot.documents) {
    if (!document || !validId(document.id) || ids.has(document.id) || document.tenant_id !== expected.tenantId
      || document.space_id !== expected.spaceId || document.project_id !== null && !validId(document.project_id)
      || typeof document.title !== "string" || document.title.length > 500
      || !["text", "url", "code", "pdf"].includes(document.content_type)
      || document.source_url !== null && typeof document.source_url !== "string"
      || document.source_sha256 !== undefined && document.source_sha256 !== null && !/^[a-f0-9]{64}$/.test(document.source_sha256)
      || document.source_file_name !== undefined && document.source_file_name !== null &&
        (typeof document.source_file_name !== "string" || document.source_file_name.length > 255)
      || document.parser_version !== undefined && document.parser_version !== null &&
        (typeof document.parser_version !== "string" || document.parser_version.length > 128)
      || document.parser_output_sha256 !== undefined && document.parser_output_sha256 !== null && !/^[a-f0-9]{64}$/.test(document.parser_output_sha256)
      || document.approved_content_sha256 !== undefined && document.approved_content_sha256 !== null && !/^[a-f0-9]{64}$/.test(document.approved_content_sha256)
      || document.source_adapter !== undefined && !["manual", "website", "connector"].includes(document.source_adapter)
      || document.source_revision !== undefined && (!Number.isSafeInteger(document.source_revision) || document.source_revision < 1)
      || document.source_content_sha256 !== undefined && document.source_content_sha256 !== null && !/^[a-f0-9]{64}$/.test(document.source_content_sha256)
      || document.source_connection_ref !== undefined && document.source_connection_ref !== null
        && (typeof document.source_connection_ref !== "string" || !document.source_connection_ref || document.source_connection_ref.length > 256)
      || document.source_grant_revision !== undefined && document.source_grant_revision !== null
        && (!Number.isSafeInteger(document.source_grant_revision) || document.source_grant_revision < 1)
      || document.source_state !== undefined && !["current", "stale", "revoked", "unsupported"].includes(document.source_state)
      || document.source_adapter === "connector" && (!document.source_connection_ref || !document.source_grant_revision)
      || typeof document.source_sha256 === "string" && (document.content_type !== "pdf"
        || typeof document.parser_version !== "string" || !document.parser_version
        || typeof document.parser_output_sha256 !== "string" || typeof document.approved_content_sha256 !== "string")
      || typeof document.created_at !== "string" || typeof document.updated_at !== "string"
      || document.status !== "indexed" || !Number.isSafeInteger(document.chunk_count) || document.chunk_count < 0
      || !Number.isSafeInteger(document.required_role_rank) || document.required_role_rank < 0 || document.required_role_rank > 50
      || !Number.isFinite(Date.parse(document.created_at)) || !Number.isFinite(Date.parse(document.updated_at))
      || !Array.isArray(document.chunks) || document.chunks.length !== document.chunk_count
      || !Array.isArray(document.objectReferences)) throw new Error("knowledge_archive_document_invalid");
    ids.add(document.id);
    const acl = parseAcl(document.allowed_user_ids_json);
    if (JSON.stringify(acl) !== document.allowed_user_ids_json) throw new Error("knowledge_archive_acl_invalid");
    const expectedProject = document.project_id ?? "_space";
    for (const [index, chunk] of document.chunks.entries()) {
      if (!chunk || chunk.id !== `${document.id}_chunk_${index}` || chunk.tenant_id !== expected.tenantId
        || chunk.space_id !== expected.spaceId || chunk.project_id !== expectedProject || chunk.document_id !== document.id
        || chunk.chunk_index !== index || typeof chunk.content !== "string" || !/^[a-f0-9]{64}$/.test(chunk.content_hash)
        || !["space", "project"].includes(chunk.visibility) || !Number.isSafeInteger(chunk.required_role_rank)
        || chunk.required_role_rank < 0 || chunk.required_role_rank > 50 || typeof chunk.r2_key !== "string"
        || !Number.isSafeInteger(chunk.byte_start) || !Number.isSafeInteger(chunk.byte_end)
        || !Number.isSafeInteger(chunk.line_start) || !Number.isSafeInteger(chunk.line_end)
        || chunk.deleted_at !== null) throw new Error("knowledge_archive_chunk_invalid");
      if (await contentHash(chunk.content) !== chunk.content_hash
        || chunk.r2_key !== `kb/${expected.spaceId}/${expectedProject}/${document.id}/chunk_${index}.txt`) {
        throw new Error("knowledge_archive_chunk_invalid");
      }
    }
    for (const reference of document.objectReferences) {
      if (!reference || !objectKeyAllowed(reference.key, expected.spaceId, document.project_id, document.id)
        || typeof reference.etag !== "string" || !reference.etag || !Number.isSafeInteger(reference.size) || reference.size < 0 || reference.size > MAX_OBJECT_BYTES
        || keys.has(reference.key)) throw new Error("knowledge_archive_object_reference_invalid");
      keys.add(reference.key); totalObjects++; totalObjectBytes += reference.size;
    }
    if (document.source_sha256 && !document.objectReferences.some((reference) =>
      reference.key === `kb/${expected.spaceId}/${expectedProject}/${document.id}/original`)) {
      throw new Error("knowledge_archive_pdf_source_missing");
    }
    if (document.chunks.some((chunk, index) => !document.objectReferences.some((ref) => ref.key ===
      `kb/${expected.spaceId}/${expectedProject}/${document.id}/chunk_${index}.txt`)
      || !document.objectReferences.some((ref) => ref.key === `kb/${expected.spaceId}/${expectedProject}/${document.id}/chunk_${index}.json`))) {
      throw new Error("knowledge_archive_chunk_objects_incomplete");
    }
    totalChunks += document.chunks.length;
    totalD1Bytes += new TextEncoder().encode(JSON.stringify(document)).byteLength;
  }
  if (totalChunks > MAX_CHUNKS || totalD1Bytes > MAX_D1_BYTES || totalObjects > MAX_OBJECTS
    || totalObjectBytes > MAX_TOTAL_OBJECT_BYTES) throw new Error("knowledge_archive_snapshot_limit_exceeded");
  return snapshot as KnowledgeArchiveSnapshot;
}

async function documentDisposition(
  env: KnowledgeArchiveBindings,
  document: KnowledgeArchiveDocument,
  restoreId: string,
): Promise<"tombstoned" | "preserved" | "resume" | "insert"> {
  const tombstone = await env.PLATFORM_DB.prepare(`SELECT document_id FROM kb_document_deletion_operations
    WHERE document_id=? AND tenant_id=? AND space_id=?`).bind(document.id, document.tenant_id, document.space_id).first();
  if (tombstone) return "tombstoned";
  const current = await env.PLATFORM_DB.prepare(`SELECT tenant_id,space_id,archive_restore_id FROM kb_documents WHERE id=?`)
    .bind(document.id).first<{ tenant_id: string; space_id: string; archive_restore_id: string | null }>();
  if (!current) return "insert";
  if (current.tenant_id !== document.tenant_id || current.space_id !== document.space_id) throw new Error("knowledge_archive_document_id_conflict");
  return current.archive_restore_id === restoreId ? "resume" : "preserved";
}

async function acquireArchiveRestoreLease(
  env: KnowledgeArchiveBindings,
  document: KnowledgeArchiveDocument,
  restoreId: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const leaseUntil = new Date(Date.now() + 10 * 60_000).toISOString();
  const result = await env.PLATFORM_DB.prepare(`INSERT INTO kb_document_mutation_leases
    (document_id,tenant_id,space_id,lease_token,lease_until,created_at)
    SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM kb_documents WHERE id=? AND tenant_id=? AND space_id=? AND archive_restore_id=?)
      AND NOT EXISTS (SELECT 1 FROM kb_document_deletion_operations WHERE document_id=? AND tenant_id=? AND space_id=?)
    ON CONFLICT(document_id) DO UPDATE SET tenant_id=excluded.tenant_id,space_id=excluded.space_id,
      lease_token=excluded.lease_token,lease_until=excluded.lease_until,created_at=excluded.created_at
    WHERE kb_document_mutation_leases.lease_until<=? OR kb_document_mutation_leases.lease_token=?`)
    .bind(document.id, document.tenant_id, document.space_id, restoreId, leaseUntil, now,
      document.id, document.tenant_id, document.space_id, restoreId,
      document.id, document.tenant_id, document.space_id, now, restoreId).run();
  return result.meta.changes > 0;
}

export async function previewKnowledgeArchiveRestore(
  env: KnowledgeArchiveBindings,
  snapshot: KnowledgeArchiveSnapshot,
  restoreId: string,
): Promise<{ documents: { willRestore: number; preservedCurrent: number; blockedByDeletion: number; requiresReindex: number };
  chunks: { willRestore: number; preservedCurrent: number }; excludedObjectKeys: string[] }> {
  let willRestore = 0, preservedCurrent = 0, blockedByDeletion = 0, chunksToRestore = 0, preservedChunks = 0;
  const excludedObjectKeys: string[] = [];
  for (const document of snapshot.documents) {
    const disposition = await documentDisposition(env, document, restoreId);
    if (disposition === "insert" || disposition === "resume") {
      willRestore++;
      chunksToRestore += document.chunks.length;
    } else {
      preservedCurrent += disposition === "preserved" ? 1 : 0;
      preservedChunks += disposition === "preserved" ? document.chunks.length : 0;
      blockedByDeletion += disposition === "tombstoned" ? 1 : 0;
      excludedObjectKeys.push(...document.objectReferences.map((reference) => reference.key));
    }
  }
  return { documents: { willRestore, preservedCurrent, blockedByDeletion, requiresReindex: willRestore },
    chunks: { willRestore: chunksToRestore, preservedCurrent: preservedChunks }, excludedObjectKeys };
}

export async function restoreKnowledgeArchive(
  env: KnowledgeArchiveBindings,
  snapshot: KnowledgeArchiveSnapshot,
  restoreId: string,
): Promise<{ restoredDocuments: number; restoredChunks: number; preservedCurrentDocuments: number;
  blockedByDeletionDocuments: number; requiresReindexDocuments: number }> {
  let restoredDocuments = 0, restoredChunks = 0, preservedCurrentDocuments = 0, blockedByDeletionDocuments = 0;
  for (const document of snapshot.documents) {
    const disposition = await documentDisposition(env, document, restoreId);
    if (disposition === "tombstoned") {
      await Promise.all(document.objectReferences.map((reference) => env.KB_BUCKET.delete(reference.key)));
      blockedByDeletionDocuments++;
      continue;
    }
    if (disposition === "preserved") {
      preservedCurrentDocuments++;
      continue;
    }
    if (disposition === "insert") {
      const result = await env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO kb_documents
        (id,space_id,tenant_id,project_id,title,source_url,content_type,status,chunk_count,required_role_rank,
         allowed_user_ids_json,source_sha256,source_file_name,parser_version,parser_output_sha256,approved_content_sha256,
         created_at,updated_at,source_adapter,source_revision,source_content_sha256,source_connection_ref,
         source_grant_revision,source_state,archive_restore_id)
        SELECT ?,?,?,?,?,?,?,'processing',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (
          SELECT 1 FROM kb_document_deletion_operations WHERE document_id=? AND tenant_id=? AND space_id=?)`)
        .bind(document.id, document.space_id, document.tenant_id, document.project_id, document.title, document.source_url,
          document.content_type, document.chunk_count, document.required_role_rank, document.allowed_user_ids_json,
          document.source_sha256 ?? null, document.source_file_name ?? null, document.parser_version ?? null,
          document.parser_output_sha256 ?? null, document.approved_content_sha256 ?? null,
          document.created_at, document.updated_at, document.source_adapter ?? "manual", document.source_revision ?? 1,
          document.source_content_sha256 ?? null, document.source_connection_ref ?? null, document.source_grant_revision ?? null,
          document.source_state ?? "current", restoreId, document.id, document.tenant_id, document.space_id).run();
      if (!result.meta.changes) {
        const refreshed = await documentDisposition(env, document, restoreId);
        if (refreshed === "tombstoned") {
          await Promise.all(document.objectReferences.map((reference) => env.KB_BUCKET.delete(reference.key)));
          blockedByDeletionDocuments++;
          continue;
        }
        if (refreshed === "preserved") { preservedCurrentDocuments++; continue; }
        throw new Error("knowledge_archive_document_insert_unavailable");
      }
    }
    if (!await acquireArchiveRestoreLease(env, document, restoreId)) {
      const refreshed = await documentDisposition(env, document, restoreId);
      if (refreshed === "tombstoned") {
        await Promise.all(document.objectReferences.map((reference) => env.KB_BUCKET.delete(reference.key)));
        blockedByDeletionDocuments++;
        continue;
      }
      if (refreshed === "preserved") { preservedCurrentDocuments++; continue; }
      throw new Error("knowledge_archive_restore_busy");
    }
    try {
      for (const reference of document.objectReferences) {
        const object = await env.KB_BUCKET.head(reference.key);
        if (!object || object.size !== reference.size) throw new Error("knowledge_archive_object_missing_after_restore");
      }
      if (document.source_sha256) {
        const sourceKey = `kb/${document.space_id}/${document.project_id ?? "_space"}/${document.id}/original`;
        const source = await env.KB_BUCKET.get(sourceKey);
        if (!source || await sourceHash(await source.arrayBuffer()) !== document.source_sha256) {
          throw new Error("knowledge_archive_pdf_source_hash_mismatch");
        }
      }
    for (let start = 0; start < document.chunks.length; start += 100) {
      if (!await renewKnowledgeDocumentMutationLease(env.PLATFORM_DB, document.id, restoreId)) {
        throw new Error("knowledge_archive_restore_deletion_fence");
      }
      const batch = document.chunks.slice(start, start + 100).map((chunk) => env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO kb_chunks
        (${CHUNK_COLUMNS}) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (
          SELECT 1 FROM kb_documents d WHERE d.id=? AND d.tenant_id=? AND d.space_id=? AND d.archive_restore_id=?)
          AND NOT EXISTS (SELECT 1 FROM kb_document_deletion_operations x WHERE x.document_id=? AND x.tenant_id=? AND x.space_id=?)`)
        .bind(chunk.id, chunk.tenant_id, chunk.space_id, chunk.project_id, chunk.document_id, chunk.chunk_index, chunk.content,
          chunk.content_hash, chunk.visibility, chunk.required_role_rank, chunk.source_freshness, chunk.heading_path, chunk.r2_key,
          chunk.byte_start, chunk.byte_end, chunk.line_start, chunk.line_end, chunk.created_at, chunk.deleted_at,
          document.id, document.tenant_id, document.space_id, restoreId, document.id, document.tenant_id, document.space_id));
      if (batch.length) await env.PLATFORM_DB.batch(batch);
    }
    if (!await renewKnowledgeDocumentMutationLease(env.PLATFORM_DB, document.id, restoreId)) {
      throw new Error("knowledge_archive_restore_deletion_fence");
    }
    const finalized = await env.PLATFORM_DB.prepare(`UPDATE kb_documents SET status='reindex_required',archive_restore_id=NULL,
      updated_at=datetime('now') WHERE id=? AND tenant_id=? AND space_id=? AND archive_restore_id=?
        AND NOT EXISTS (SELECT 1 FROM kb_document_deletion_operations WHERE document_id=? AND tenant_id=? AND space_id=?)`)
      .bind(document.id, document.tenant_id, document.space_id, restoreId, document.id, document.tenant_id, document.space_id).run();
    if (!finalized.meta.changes) {
      const refreshed = await documentDisposition(env, document, restoreId);
      if (refreshed === "tombstoned") {
        await Promise.all(document.objectReferences.map((reference) => env.KB_BUCKET.delete(reference.key)));
        blockedByDeletionDocuments++;
        continue;
      }
      if (refreshed === "preserved") { preservedCurrentDocuments++; continue; }
      throw new Error("knowledge_archive_restore_finalize_unavailable");
    }
    restoredDocuments++;
    restoredChunks += document.chunks.length;
    } catch (error) {
      const refreshed = await documentDisposition(env, document, restoreId);
      if (refreshed === "tombstoned") {
        await Promise.all(document.objectReferences.map((reference) => env.KB_BUCKET.delete(reference.key)));
        blockedByDeletionDocuments++;
        continue;
      }
      throw error;
    } finally {
      await releaseKnowledgeDocumentMutationLease(env.PLATFORM_DB, document.id, restoreId);
    }
  }
  return { restoredDocuments, restoredChunks, preservedCurrentDocuments, blockedByDeletionDocuments,
    requiresReindexDocuments: restoredDocuments };
}
