export const SEMANTIC_CACHE_THRESHOLD = 0.96;

export interface SemanticCacheBindings {
  vectors: Pick<VectorizeIndex, "query">;
  kv: Pick<KVNamespace, "get">;
}

export async function lookupSemanticCache(
  bindings: SemanticCacheBindings,
  embedding: number[],
  spaceId: string,
  now = Date.now()
): Promise<{ id: string; text: string; score: number } | null> {
  const result = await bindings.vectors.query(embedding, {
    topK: 1,
    filter: { space_id: { $eq: spaceId } },
    returnMetadata: "indexed",
  });
  const match = result.matches?.[0];
  const score = match?.score;
  // The invariant is strictly greater than .96, not greater-than-or-equal.
  if (
    !match ||
    typeof score !== "number" ||
    !Number.isFinite(score) ||
    score <= SEMANTIC_CACHE_THRESHOLD
  )
    return null;
  const expiry = Number(
    (match.metadata as Record<string, unknown> | undefined)?.expires_at
  );
  if (!Number.isFinite(expiry) || expiry <= now) return null;
  const text = await bindings.kv.get(`sc:${match.id}`);
  return text === null ? null : { id: match.id, text, score };
}
