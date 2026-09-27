import { bm25Score, reciprocalRankFusion, type GroundedSearchHit } from "@naelao/rag";

/** Rank the same permission-filtered candidate population sparsely, then fuse it with dense
 * ordering. This prevents BM25 from observing documents that the caller cannot access. */
export function hybridRank(query: string, dense: GroundedSearchHit[], candidates: GroundedSearchHit[]): GroundedSearchHit[] {
  const sparse = bm25Score(query, candidates.map(({ id, content }) => ({ id, content })));
  const source = new Map([...dense, ...candidates].map((hit) => [hit.id, hit]));
  return reciprocalRankFusion(dense, sparse, 60).flatMap(({ id, score }) => {
    const hit = source.get(id);
    return hit ? [{ ...hit, score }] : [];
  });
}

export function sparseRank(query: string, candidates: GroundedSearchHit[]): GroundedSearchHit[] {
  const byId = new Map(candidates.map((hit) => [hit.id, hit]));
  return bm25Score(query, candidates.map(({ id, content }) => ({ id, content }))).flatMap(({ id, score }) => {
    const hit = byId.get(id);
    return hit ? [{ ...hit, score }] : [];
  });
}
