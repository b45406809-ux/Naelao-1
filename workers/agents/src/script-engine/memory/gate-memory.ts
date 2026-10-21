import type { Embedder, MemoryRecallResult } from "../types.js";

/** Hindsight memories are untrusted retrieval candidates until they clear this gate. */
export const SEMANTIC_MEMORY_THRESHOLD = 0.8;

export interface SemanticMemoryCandidate extends MemoryRecallResult {
  embedding?: number[];
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i++) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

/**
 * Admit semantic/episodic hindsight only when it is demonstrably relevant to the active prompt.
 * Vectorize scores are accepted when embeddings are not returned; callers that have candidate
 * vectors can ask us to independently recompute cosine similarity with the same strict boundary.
 */
export async function gateMemory(
  query: string | number[],
  candidates: SemanticMemoryCandidate[],
  embedder?: Embedder
): Promise<SemanticMemoryCandidate[]> {
  const queryEmbedding = Array.isArray(query) ? query : embedder ? await embedder.embed(query) : undefined;
  return candidates
    .map((candidate) => ({
      ...candidate,
      score:
        queryEmbedding && candidate.embedding
          ? cosineSimilarity(queryEmbedding, candidate.embedding)
          : candidate.score,
    }))
    .filter((candidate) => Number.isFinite(candidate.score) && candidate.score > SEMANTIC_MEMORY_THRESHOLD)
    .sort((a, b) => b.score - a.score);
}

/** The only renderer for semantic recall used in model context. */
export function renderRecalledMemory(candidates: SemanticMemoryCandidate[]): string {
  return candidates
    .filter((candidate) => candidate.score > SEMANTIC_MEMORY_THRESHOLD)
    .map((candidate) => `<recalled_memory score="${candidate.score.toFixed(3)}">${candidate.text}</recalled_memory>`)
    .join("\n");
}
