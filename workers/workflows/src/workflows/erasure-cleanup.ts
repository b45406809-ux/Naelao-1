const MAX_DOCUMENT_CHUNKS = 12_000;
const R2_DELETE_BATCH_SIZE = 100;
const KV_DELETE_BATCH_SIZE = 100;

export async function deleteKvPrefix(
  kv: Pick<KVNamespace, "list" | "delete">,
  prefix: string
): Promise<number> {
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  let deleted = 0;
  do {
    const listed = await kv.list(cursor === undefined ? { prefix } : { prefix, cursor });
    for (let start = 0; start < listed.keys.length; start += KV_DELETE_BATCH_SIZE) {
      const batch = listed.keys.slice(start, start + KV_DELETE_BATCH_SIZE);
      await Promise.all(batch.map(({ name }) => kv.delete(name)));
      deleted += batch.length;
    }
    if (listed.list_complete) return deleted;
    const nextCursor = listed.cursor;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      throw new Error("KV erasure returned a missing or repeated cursor");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor !== undefined);
  return deleted;
}

export interface ErasureDocument {
  id: string;
  project_id: string | null;
  chunk_count: number | null;
}

export async function eraseSpaceD1Records(db: D1Database, spaceId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM kb_chunks WHERE space_id = ?").bind(spaceId),
    db.prepare("DELETE FROM kb_documents WHERE space_id = ?").bind(spaceId),
    db.prepare("DELETE FROM active_sessions WHERE space_id = ?").bind(spaceId),
    db.prepare("DELETE FROM thread_sessions WHERE space_id = ?").bind(spaceId),
    db.prepare("DELETE FROM threads WHERE space_id = ?").bind(spaceId),
  ]);
}

export async function anonymizeOrgUsers(db: D1Database, orgId: string): Promise<void> {
  await db.prepare(
    `UPDATE users
     SET email = 'erased-' || id || '@deleted.invalid', password_hash = NULL,
         last_login_at = NULL, status = 'erased', preferred_language = NULL
     WHERE org_id = ?`
  ).bind(orgId).run();
}

function documentPrefix(spaceId: string, projectId: string | null, documentId: string): string {
  return `kb/${spaceId}/${projectId ?? "_space"}/${documentId}/`;
}

function autoragKey(spaceId: string, projectId: string | null, documentId: string): string {
  return `autorag/${spaceId}/${projectId ?? "_space"}/${documentId}.md`;
}

async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  do {
    const listed = await bucket.list(cursor === undefined ? { prefix, limit: 1000 } : { prefix, cursor, limit: 1000 });
    for (let start = 0; start < listed.objects.length; start += R2_DELETE_BATCH_SIZE) {
      await Promise.all(listed.objects.slice(start, start + R2_DELETE_BATCH_SIZE).map(({ key }) => bucket.delete(key)));
    }
    if (!listed.truncated) return;
    const nextCursor = listed.cursor;
    if (!nextCursor || seenCursors.has(nextCursor)) throw new Error("R2 erasure returned a missing or repeated cursor");
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor !== undefined);
}

function validatedChunkCount(value: number | null): number {
  if (value === null) return 0;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DOCUMENT_CHUNKS) {
    throw new Error("Invalid knowledge document chunk count during erasure");
  }
  return value;
}

/** Delete every project-scoped object and vector for the supplied space documents. */
export async function eraseSpaceKnowledgeResources(
  spaceId: string,
  documents: ErasureDocument[],
  bucket: R2Bucket,
  vectors: VectorizeIndex,
): Promise<void> {
  for (const document of documents) {
    const count = validatedChunkCount(document.chunk_count);
    await deleteR2Prefix(bucket, documentPrefix(spaceId, document.project_id, document.id));
    await bucket.delete(autoragKey(spaceId, document.project_id, document.id));
    for (let start = 0; start < count; start += R2_DELETE_BATCH_SIZE) {
      const end = Math.min(start + R2_DELETE_BATCH_SIZE, count);
      const ids = Array.from({ length: end - start }, (_, offset) => `${document.id}_chunk_${start + offset}`);
      await vectors.deleteByIds(ids);
    }
  }
  // Remove leftovers from partially indexed or pre-project-scope documents as well.
  await deleteR2Prefix(bucket, `kb/${spaceId}/`);
  await deleteR2Prefix(bucket, `autorag/${spaceId}/`);
}
