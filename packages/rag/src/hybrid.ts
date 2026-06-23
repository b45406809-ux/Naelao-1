/**
 * Hybrid retrieval: dense (Vectorize) + sparse (BM25 keyword) scoring
 * combined via Reciprocal Rank Fusion (RRF).
 */

export interface RetrievalResult {
  chunkId: string;
  docId: string;
  content: string;
  /** Fused RRF score */
  score: number;
  denseScore: number;
  sparseScore: number;
}

/**
 * Reciprocal Rank Fusion — standard RRF constant k=60.
 *
 * RRF formula: score(d) = Σ 1/(k + rank(d))
 * Where rank is 1-based position in each result list.
 *
 * @param denseResults  - Results from vector search, sorted by descending score
 * @param sparseResults - Results from keyword/BM25 search, sorted by descending score
 * @param k             - RRF smoothing constant (default 60)
 * @returns Merged list sorted by descending fused score
 */
export function reciprocalRankFusion(
  denseResults: Array<{ id: string; score: number }>,
  sparseResults: Array<{ id: string; score: number }>,
  k = 60,
): Array<{ id: string; score: number }> {
  const scoreMap = new Map<string, number>();

  // Accumulate RRF scores from dense ranking
  for (let rank = 0; rank < denseResults.length; rank++) {
    const result = denseResults[rank];
    if (!result) continue;
    const existing = scoreMap.get(result.id) ?? 0;
    scoreMap.set(result.id, existing + 1 / (k + rank + 1));
  }

  // Accumulate RRF scores from sparse ranking
  for (let rank = 0; rank < sparseResults.length; rank++) {
    const result = sparseResults[rank];
    if (!result) continue;
    const existing = scoreMap.get(result.id) ?? 0;
    scoreMap.set(result.id, existing + 1 / (k + rank + 1));
  }

  // Sort by descending fused score
  return Array.from(scoreMap.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Simplified BM25-style keyword overlap scoring.
 * Tokenises query and document content, then scores by term frequency overlap.
 * Returns results sorted by descending score (zero-score docs excluded).
 *
 * @param query     - The search query
 * @param documents - Array of documents with id and content
 */
export function bm25Score(
  query: string,
  documents: Array<{ id: string; content: string }>,
): Array<{ id: string; score: number }> {
  const queryTerms = tokenise(query);
  if (queryTerms.length === 0) return [];

  // Compute IDF-like weights: terms appearing in fewer docs are more valuable
  const docFreq = new Map<string, number>();
  for (const doc of documents) {
    const docTerms = new Set(tokenise(doc.content));
    for (const term of queryTerms) {
      if (docTerms.has(term)) {
        docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
      }
    }
  }

  const N = documents.length;

  const scored: Array<{ id: string; score: number }> = [];

  for (const doc of documents) {
    const docTerms = tokenise(doc.content);
    const termFreq = new Map<string, number>();
    for (const term of docTerms) {
      termFreq.set(term, (termFreq.get(term) ?? 0) + 1);
    }

    const docLength = docTerms.length;
    if (docLength === 0) continue;

    // BM25 parameters
    const k1 = 1.5;
    const b = 0.75;
    // Approximate average document length (we use current doc length as a proxy
    // since we don't have corpus-level stats — harmless simplification)
    const avgdl = docLength;

    let score = 0;

    for (const term of queryTerms) {
      const tf = termFreq.get(term) ?? 0;
      if (tf === 0) continue;

      const df = docFreq.get(term) ?? 0;
      if (df === 0) continue;

      // IDF component (Robertson-Sparck Jones variant)
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

      // TF component with length normalisation
      const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLength / avgdl)));

      score += idf * tfNorm;
    }

    if (score > 0) {
      scored.push({ id: doc.id, score });
    }
  }

  return scored.sort((a, b) => b.score - a.score);
}

/**
 * Tokenise text into lowercase alphanumeric terms, removing stopwords.
 */
function tokenise(text: string): string[] {
  const STOPWORDS = new Set([
    "a", "an", "the", "is", "it", "in", "on", "at", "to", "for", "of",
    "and", "or", "but", "not", "with", "this", "that", "be", "are", "was",
    "were", "as", "by", "from", "have", "has", "had", "do", "does", "did",
    "will", "would", "could", "should", "may", "might", "can", "its", "their",
    "there", "which", "who", "what", "when", "where", "how", "if", "then",
    "so", "up", "out", "about", "into", "than", "more", "also", "been",
  ]);

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOPWORDS.has(t));
}
