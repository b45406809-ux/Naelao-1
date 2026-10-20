import { bm25Score, reciprocalRankFusion, type GroundedSearchHit } from "@naelao/rag";

const MAX_QUERY_CHARS = 1_000;
const MAX_CANDIDATES = 200;
const MAX_BM25_CONTENT_CHARS = 16_384;

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
