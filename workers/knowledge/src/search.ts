import { bm25Score, reciprocalRankFusion, type GroundedSearchHit } from "@naelao/rag";
import { buildRetrievalPredicate } from "@naelao/security";

const MAX_QUERY_CHARS = 1_000;
const MAX_CANDIDATES = 200;
const MAX_BM25_CONTENT_CHARS = 16_384;
const MAX_FTS_CANDIDATES = 200;

function assertSearchInput(query: string, candidates: GroundedSearchHit[]): void {
  if (typeof query !== "string" || !query.trim() || query.length > MAX_QUERY_CHARS) {
    throw new RangeError(`search query must contain 1 to ${MAX_QUERY_CHARS} characters`);
  }
  if (!Array.isArray(candidates) || candidates.length > MAX_CANDIDATES) {
    throw new RangeError(`sparse search supports at most ${MAX_CANDIDATES} candidates`);
  }
  if (candidates.some((hit) => !hit || typeof hit.id !== "string" || !hit.id || typeof hit.content !== "string")) {
    throw new TypeError("sparse search candidates must have string IDs and content");
  }
}

function bm25Candidates(candidates: GroundedSearchHit[]): Array<{ id: string; content: string }> {
  return candidates.map(({ id, content }) => ({ id, content: content.slice(0, MAX_BM25_CONTENT_CHARS) }));
}

/** Rank the same permission-filtered candidate population sparsely, then fuse it with dense
 * ordering. This prevents BM25 from observing documents that the caller cannot access. */
export function hybridRank(query: string, dense: GroundedSearchHit[], candidates: GroundedSearchHit[]): GroundedSearchHit[] {
  assertSearchInput(query, candidates);
  if (!Array.isArray(dense) || dense.length > MAX_CANDIDATES) {
    throw new RangeError(`dense search supports at most ${MAX_CANDIDATES} candidates`);
  }
  assertSearchInput(query, dense);
  const sparse = bm25Score(query, bm25Candidates(candidates)).filter(({ score }) => score > 0);
  const source = new Map([...dense, ...candidates].map((hit) => [hit.id, hit]));
  return reciprocalRankFusion(dense, sparse, 60).flatMap(({ id, score }) => {
    const hit = source.get(id);
    return hit ? [{ ...hit, score }] : [];
  });
}

export function sparseRank(query: string, candidates: GroundedSearchHit[]): GroundedSearchHit[] {
  assertSearchInput(query, candidates);
  const byId = new Map(candidates.map((hit) => [hit.id, hit]));
  return bm25Score(query, bm25Candidates(candidates)).filter(({ score }) => score > 0).flatMap(({ id, score }) => {
    const hit = byId.get(id);
    return hit ? [{ ...hit, score }] : [];
  });
}

function safeStoredHeadingPath(value: unknown): string[] | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length > 0 && parsed.length <= 16
      && parsed.every((part) => typeof part === "string" && part.trim().length > 0 && part.length <= 200)
      ? parsed as string[] : undefined;
  } catch { return undefined; }
}

/** Generate lexical candidates independently from Vectorize. Tenant, Space, Project, role,
 * document publication and user allowlist checks live in the SQL query, before any candidate is
 * returned to the caller or fused with dense results. FTS syntax is built only from bounded
 * alphanumeric tokens, never from raw query operators. */
export async function queryScopedFtsCandidates(input: {
  db: Pick<D1Database, "prepare">;
  query: string;
  tenantId: string;
  spaceId: string;
  projectId: string;
  userId: string;
  roleRank: number;
  limit?: number;
}): Promise<GroundedSearchHit[]> {
  if (!input.query.trim() || input.query.length > 1_000 || !input.tenantId || !input.spaceId
    || !input.projectId || !input.userId || !Number.isFinite(input.roleRank)) {
    throw new Error("complete bounded Knowledge lexical scope is required");
  }
  const terms = input.query.normalize("NFKC").match(/[\p{L}\p{N}_]+/gu)?.slice(0, 32) ?? [];
  if (!terms.length) return [];
  const quotedTerms = terms.map((term) => `"${term.slice(0, 64)}"`);
  const termAlternatives = quotedTerms.join(" OR ");
  const phrase = quotedTerms.length > 1 ? ` OR "${terms.map((term) => term.slice(0, 64)).join(" ")}"` : "";
  const matchExpression = phrase ? `(${termAlternatives})${phrase}` : termAlternatives;
  const limit = input.limit ?? MAX_FTS_CANDIDATES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_FTS_CANDIDATES) {
    throw new RangeError(`FTS candidate limit must be from 1 to ${MAX_FTS_CANDIDATES}`);
  }
  const scope = buildRetrievalPredicate("k", input);
  const { results } = await input.db.prepare(`
    SELECT k.id,k.content,k.content_hash,k.r2_key,k.byte_start,k.byte_end,k.line_start,k.line_end,k.heading_path,
      d.title,d.source_adapter,d.source_revision,d.source_content_sha256,d.source_grant_revision
    FROM kb_chunks_fts
    JOIN kb_chunks k ON k.rowid=kb_chunks_fts.rowid
    JOIN kb_documents d ON d.id=k.document_id AND d.tenant_id=k.tenant_id AND d.space_id=k.space_id
    WHERE kb_chunks_fts MATCH ? AND ${scope.sql}
      AND k.deleted_at IS NULL AND d.status='indexed'
      AND d.source_state='current'
      AND (d.allowed_user_ids_json IS NULL
        OR (json_valid(d.allowed_user_ids_json) AND json_type(d.allowed_user_ids_json)='array'
          AND (json_array_length(d.allowed_user_ids_json)=0
            OR EXISTS (SELECT 1 FROM json_each(d.allowed_user_ids_json) acl WHERE acl.value=?))))
      AND (d.source_adapter!='website' OR (d.source_state='current' AND EXISTS (
        SELECT 1 FROM website_connections wc WHERE wc.id=d.source_connection_ref AND wc.tenant_id=d.tenant_id
          AND wc.space_id=d.space_id AND wc.project_id=d.project_id AND wc.status='active'
      )))
    ORDER BY bm25(kb_chunks_fts) ASC,k.id ASC
    LIMIT ?
  `).bind(matchExpression, ...scope.binds, input.userId, limit).all<{
    id: string; content: string; content_hash: string; r2_key: string; byte_start: number; byte_end: number;
    line_start: number; line_end: number; heading_path: string; title: string | null; source_adapter: string;
    source_revision: number; source_content_sha256: string | null; source_grant_revision: number | null;
  }>();
  return results.map((row) => {
    const headingPath = safeStoredHeadingPath(row.heading_path);
    return {
      id: row.id,
      score: 0,
      content: row.content,
      ...(typeof row.content_hash === "string" && /^[a-f0-9]{64}$/.test(row.content_hash) ? { contentHash: row.content_hash } : {}),
      r2Key: row.r2_key,
      byteStart: row.byte_start,
      byteEnd: row.byte_end,
      lineStart: row.line_start,
      lineEnd: row.line_end,
      ...(headingPath ? { headingPath } : {}),
      ...(Number.isSafeInteger(row.source_revision) && row.source_revision > 0 ? { sourceRevision: row.source_revision } : {}),
      ...(typeof row.source_adapter === "string" && row.source_adapter.length > 0 && row.source_adapter.length <= 32
        ? { sourceAdapter: row.source_adapter } : {}),
      ...(typeof row.source_content_sha256 === "string" && /^[a-f0-9]{64}$/.test(row.source_content_sha256)
        ? { sourceContentSha256: row.source_content_sha256 } : {}),
      ...(Number.isSafeInteger(row.source_grant_revision) && Number(row.source_grant_revision) > 0
        ? { sourceGrantRevision: Number(row.source_grant_revision) } : {}),
      title: row.title ?? "",
    };
  });
}
