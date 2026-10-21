export const SEMANTIC_CACHE_THRESHOLD = 0.96;

export interface SemanticCacheBindings {
  vectors: Pick<VectorizeIndex, "query">;
  kv: Pick<KVNamespace, "get">;
}

export interface SemanticCacheScope {
  tenantId: string;
  spaceId: string;
  generation?: string;
}

export async function lookupSemanticCache(
  bindings: SemanticCacheBindings,
  embedding: number[],
  scope: SemanticCacheScope,
  now = Date.now()
): Promise<{ id: string; text: string; score: number } | null> {
  if (!scope.tenantId || !scope.spaceId || !Array.isArray(embedding) || !embedding.length || !embedding.every(Number.isFinite)) {
    throw new Error("Complete semantic cache scope and embedding are required");
  }
  const result = await bindings.vectors.query(embedding, {
    topK: 1,
    filter: {
      tenant_id: { $eq: scope.tenantId },
      space_id: { $eq: scope.spaceId },
      generation: { $eq: scope.generation ?? "0" },
    },
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
  const expiry = (match.metadata as Record<string, unknown> | undefined)?.expires_at;
  if (!Number.isSafeInteger(expiry) || Number(expiry) <= now) return null;
  const text = await bindings.kv.get(`sc:${match.id}`);
  return text === null || text.length > 1_048_576 ? null : { id: match.id, text, score };
}
