/** Host-derived scope and source lineage passed to an untrusted Knowledge processor. */
export interface KnowledgeExtensionContext {
  tenantId: string;
  spaceId: string;
  projectId: string | null;
  collectionId: string;
  installationId: string;
  sourceId: string;
  sourceVersion: number;
  contentSha256: string;
  sourceByteLength: number;
  sourceLineCount: number;
  deletionGeneration: number;
  parserVersion: string;
  chunkerVersion: string;
  indexVersion: string;
  retrievalVersion: string;
}

/** Processor outputs are derived data; none of these fields grants access or publication. */
export interface KnowledgeExtensionChunk {
  chunkId: string;
  text: string;
  sourceVersion: number;
  contentSha256: string;
  chunkSha256: string;
  parserVersion: string;
  chunkerVersion: string;
  byteStart: number;
  byteEnd: number;
  lineStart?: number;
  lineEnd?: number;
}

/** Retrieval adapters return references only, never content or an access decision. */
export interface KnowledgeExtensionCandidate {
  chunkId: string;
  score: number;
  sourceVersion: number;
  contentSha256: string;
  deletionGeneration: number;
  indexVersion: string;
  retrievalVersion: string;
}

export interface KnowledgeExtensionLimits {
  maxChunks?: number;
  maxChunkBytes?: number;
  maxTotalBytes?: number;
}

export interface KnowledgeExtensionSearchAdapter {
  /** Receives only host-authorized opaque chunk references, never source content or raw tenant IDs. */
  search(input: { query: string; chunkIds: string[]; indexVersion: string; retrievalVersion: string }): Promise<unknown>;
}

export interface KnowledgeExtensionAuthoritySnapshot {
  sourceVersion: number;
  contentSha256: string;
  deletionGeneration: number;
  indexVersion: string;
  retrievalVersion: string;
  authorizedChunkIds: readonly string[];
}

const ID = /^[A-Za-z0-9._:-]{1,160}$/;
const VERSION = /^[A-Za-z0-9._+-]{1,80}$/;
const HASH = /^[a-f0-9]{64}$/;

function validContext(context: KnowledgeExtensionContext): boolean {
  return ID.test(context.tenantId) && ID.test(context.spaceId)
    && (context.projectId === null || ID.test(context.projectId))
    && ID.test(context.collectionId) && ID.test(context.installationId) && ID.test(context.sourceId)
    && Number.isSafeInteger(context.sourceVersion) && context.sourceVersion > 0
    && HASH.test(context.contentSha256) && Number.isSafeInteger(context.sourceByteLength) && context.sourceByteLength >= 0
    && Number.isSafeInteger(context.sourceLineCount) && context.sourceLineCount >= 0
    && Number.isSafeInteger(context.deletionGeneration) && context.deletionGeneration >= 0
    && VERSION.test(context.parserVersion) && VERSION.test(context.chunkerVersion)
    && VERSION.test(context.indexVersion) && VERSION.test(context.retrievalVersion);
}

/** Validate and project processor output onto the narrow host contract. Unknown properties are dropped. */
async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function validateKnowledgeExtensionChunks(
  context: KnowledgeExtensionContext,
  input: unknown,
  limits: KnowledgeExtensionLimits = {},
): Promise<KnowledgeExtensionChunk[]> {
  if (!validContext(context)) throw new Error("knowledge_extension_context_invalid");
  if (!Array.isArray(input)) throw new Error("knowledge_extension_chunks_invalid");
  const maxChunks = limits.maxChunks ?? 2_000;
  const maxChunkBytes = limits.maxChunkBytes ?? 64 * 1024;
  const maxTotalBytes = limits.maxTotalBytes ?? 2 * 1024 * 1024;
  if (input.length > maxChunks) throw new Error("knowledge_extension_chunk_count_exceeded");
  const seen = new Set<string>();
  let totalBytes = 0;
  const chunks: KnowledgeExtensionChunk[] = [];
  for (const value of input) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("knowledge_extension_chunk_invalid");
    const row = value as Record<string, unknown>;
    if (typeof row.chunkId !== "string" || !ID.test(row.chunkId) || seen.has(row.chunkId)
      || typeof row.text !== "string" || !row.text.trim()
      || row.sourceVersion !== context.sourceVersion || row.contentSha256 !== context.contentSha256
      || row.parserVersion !== context.parserVersion || row.chunkerVersion !== context.chunkerVersion
      || typeof row.chunkSha256 !== "string" || !HASH.test(row.chunkSha256)
      || !Number.isSafeInteger(row.byteStart) || !Number.isSafeInteger(row.byteEnd)
      || (row.byteStart as number) < 0 || (row.byteEnd as number) <= (row.byteStart as number)
      || (row.byteEnd as number) > context.sourceByteLength) throw new Error("knowledge_extension_chunk_lineage_invalid");
    if ((row.lineStart !== undefined || row.lineEnd !== undefined)
      && (!Number.isSafeInteger(row.lineStart) || !Number.isSafeInteger(row.lineEnd)
        || (row.lineStart as number) < 1 || (row.lineEnd as number) < (row.lineStart as number)
        || (row.lineEnd as number) > context.sourceLineCount)) {
      throw new Error("knowledge_extension_chunk_coordinates_invalid");
    }
    const bytes = new TextEncoder().encode(row.text);
    totalBytes += bytes.byteLength;
    if (bytes.byteLength > maxChunkBytes || totalBytes > maxTotalBytes) throw new Error("knowledge_extension_chunk_bytes_exceeded");
    if (await sha256(row.text) !== row.chunkSha256) throw new Error("knowledge_extension_chunk_hash_invalid");
    seen.add(row.chunkId);
    chunks.push({
      chunkId: row.chunkId, text: row.text, sourceVersion: context.sourceVersion, contentSha256: context.contentSha256,
      chunkSha256: row.chunkSha256, parserVersion: context.parserVersion, chunkerVersion: context.chunkerVersion,
      byteStart: row.byteStart as number, byteEnd: row.byteEnd as number,
      ...(row.lineStart !== undefined ? { lineStart: row.lineStart as number, lineEnd: row.lineEnd as number } : {}),
    });
  }
  return chunks;
}

/** Keep untrusted retrieval output inside the host-authorized, current index/source set. */
export function validateKnowledgeExtensionCandidates(
  context: KnowledgeExtensionContext,
  authorizedCurrentChunkIds: ReadonlySet<string>,
  input: unknown,
  maxCandidates = 200,
): KnowledgeExtensionCandidate[] {
  if (!validContext(context)) throw new Error("knowledge_extension_context_invalid");
  if (!Array.isArray(input) || input.length > maxCandidates) throw new Error("knowledge_extension_candidates_invalid");
  const seen = new Set<string>();
  return input.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("knowledge_extension_candidate_invalid");
    const row = value as Record<string, unknown>;
    if (typeof row.chunkId !== "string" || !authorizedCurrentChunkIds.has(row.chunkId) || seen.has(row.chunkId)
      || typeof row.score !== "number" || !Number.isFinite(row.score) || row.score < 0 || row.score > 1
      || row.sourceVersion !== context.sourceVersion || row.contentSha256 !== context.contentSha256
      || row.deletionGeneration !== context.deletionGeneration || row.indexVersion !== context.indexVersion
      || row.retrievalVersion !== context.retrievalVersion) throw new Error("knowledge_extension_candidate_lineage_invalid");
    seen.add(row.chunkId);
    return { chunkId: row.chunkId, score: row.score, sourceVersion: context.sourceVersion,
      contentSha256: context.contentSha256, deletionGeneration: context.deletionGeneration,
      indexVersion: context.indexVersion, retrievalVersion: context.retrievalVersion };
  });
}

/**
 * Host wrapper for an untrusted custom retriever. It authorizes before ranking, passes only
 * permitted opaque chunk IDs to the adapter, then rechecks source/index/deletion authority and
 * every returned reference before the caller may materialize content or citations.
 */
export async function searchKnowledgeExtension(input: {
  context: KnowledgeExtensionContext;
  query: string;
  adapter: KnowledgeExtensionSearchAdapter;
  readAuthority(context: KnowledgeExtensionContext): Promise<KnowledgeExtensionAuthoritySnapshot>;
  maxCandidates?: number;
}): Promise<KnowledgeExtensionCandidate[]> {
  if (!validContext(input.context)) throw new Error("knowledge_extension_context_invalid");
  if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 16_000) {
    throw new Error("knowledge_extension_query_invalid");
  }
  const matchesCurrentContext = (authority: KnowledgeExtensionAuthoritySnapshot) =>
    authority.sourceVersion === input.context.sourceVersion && authority.contentSha256 === input.context.contentSha256
      && authority.deletionGeneration === input.context.deletionGeneration && authority.indexVersion === input.context.indexVersion
      && authority.retrievalVersion === input.context.retrievalVersion;
  const before = await input.readAuthority(input.context);
  if (!matchesCurrentContext(before)) throw new Error("knowledge_extension_source_stale");
  const authorized = [...new Set(before.authorizedChunkIds.filter(id => ID.test(id)))].slice(0, 2_000);
  if (authorized.length === 0) return [];
  const raw = await input.adapter.search({ query: input.query, chunkIds: authorized,
    indexVersion: input.context.indexVersion, retrievalVersion: input.context.retrievalVersion });
  const candidates = validateKnowledgeExtensionCandidates(input.context, new Set(authorized), raw, input.maxCandidates ?? 200);
  const after = await input.readAuthority(input.context);
  if (!matchesCurrentContext(after)) throw new Error("knowledge_extension_source_stale");
  const stillAuthorized = new Set(after.authorizedChunkIds);
  return candidates.filter(candidate => stillAuthorized.has(candidate.chunkId));
}
