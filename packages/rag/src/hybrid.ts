import { CitationBadge, buildCitationBadges } from "./citations.js";

export interface RankedDocument {
  id: string;
  docId: string;
  title: string;
  text: string;
  sourceUrl?: string;
  score?: number;
}

/**
 * Pure TypeScript in-memory BM25 scoring for V8 Isolates.
 */
export class EdgeBM25 {
  private k1 = 1.2;
  private b = 0.75;
  private docCount = 0;
  private avgDocLength = 0;
  private docLengths: number[] = [];
  private tokenizedDocs: string[][] = [];
  private idfMap = new Map<string, number>();

  constructor(private docs: RankedDocument[]) {
    this.docCount = docs.length;
    let totalLen = 0;

    for (const doc of docs) {
      const tokens = this.tokenize(doc.text + " " + doc.title);
      this.tokenizedDocs.push(tokens);
      this.docLengths.push(tokens.length);
      totalLen += tokens.length;
    }

    this.avgDocLength = this.docCount > 0 ? totalLen / this.docCount : 0;
    this.computeIdf();
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s§.-]/g, " ")
      .split(/\s+/)
      .filter(t => t.length > 1);
  }

  private computeIdf() {
    const termDocFreq = new Map<string, number>();

    for (const tokens of this.tokenizedDocs) {
      const unique = new Set(tokens);
      for (const t of unique) {
        termDocFreq.set(t, (termDocFreq.get(t) || 0) + 1);
      }
    }

    for (const [term, freq] of termDocFreq.entries()) {
      // Standard BM25 IDF formulation
      this.idfMap.set(term, Math.log((this.docCount - freq + 0.5) / (freq + 0.5) + 1));
    }
  }

  public score(query: string): Array<{ docIndex: number; score: number }> {
    const queryTokens = this.tokenize(query);
    const results: Array<{ docIndex: number; score: number }> = [];

    for (let i = 0; i < this.docCount; i++) {
      const docTokens = this.tokenizedDocs[i] || [];
      const docLen = this.docLengths[i] || 0;
      let score = 0;

      // Count term frequency in document
      const tf = new Map<string, number>();
      for (const t of docTokens) {
        tf.set(t, (tf.get(t) || 0) + 1);
      }

      for (const q of queryTokens) {
        const idf = this.idfMap.get(q) || 0;
        const count = tf.get(q) || 0;
        if (count > 0) {
          const numerator = count * (this.k1 + 1);
          const denominator = count + this.k1 * (1 - this.b + this.b * (docLen / this.avgDocLength));
          score += idf * (numerator / denominator);
        }
      }

      if (score > 0) {
        results.push({ docIndex: i, score });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }
}

/**
 * Fuses Dense (Vectorize) and Sparse (BM25) search rankings using RRF (k = 60).
 * Overloaded to support legacy Array<{ id: string, score: number }> format.
 */
export function reciprocalRankFusion(
  denseDocs: any[],
  sparseRankings: any[],
  allDocs?: any[],
  k: number = 60
): any[] {
  // Legacy signature:
  // reciprocalRankFusion(denseForRrf: Array<{ id: string; score: number }>, sparseForRrf: Array<{ id: string; score: number }>)
  if (!allDocs) {
    const rrfScores = new Map<string, number>();
    const constantK = typeof sparseRankings === "number" ? sparseRankings : k;

    const denseList = Array.isArray(denseDocs) ? denseDocs : [];
    const sparseList = Array.isArray(sparseRankings) ? sparseRankings : [];

    denseList.forEach((item, rank) => {
      if (item && item.id) {
        rrfScores.set(item.id, (rrfScores.get(item.id) || 0) + 1 / (constantK + rank + 1));
      }
    });

    sparseList.forEach((item, rank) => {
      if (item && item.id) {
        rrfScores.set(item.id, (rrfScores.get(item.id) || 0) + 1 / (constantK + rank + 1));
      }
    });

    return [...rrfScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id, score]) => ({ id, score }));
  }

  // New signature:
  // reciprocalRankFusion(denseDocs: RankedDocument[], sparseRankings: Array<{ docIndex: number; score: number }>, allDocs: RankedDocument[], k?: number)
  const rrfScores = new Map<string, { doc: RankedDocument; score: number }>();

  // 1. Add Dense stream ranks
  denseDocs.forEach((doc, rank) => {
    const existing = rrfScores.get(doc.id) || { doc, score: 0 };
    existing.score += 1 / (k + rank + 1);
    rrfScores.set(doc.id, existing);
  });

  // 2. Add Sparse stream ranks
  sparseRankings.forEach((item, rank) => {
    const doc = allDocs[item.docIndex];
    if (doc) {
      const existing = rrfScores.get(doc.id) || { doc, score: 0 };
      existing.score += 1 / (k + rank + 1);
      rrfScores.set(doc.id, existing);
    }
  });

  // 3. Sort descending by combined RRF score
  return [...rrfScores.values()]
    .sort((a, b) => b.score - a.score)
    .map(entry => ({
      ...entry.doc,
      score: entry.score
    }));
}

// Keep a simple export for the legacy bm25Score function so we don't break legacy code:
export function bm25Score(query: string, docs: Array<{ id: string; content: string }>): Array<{ id: string; score: number }> {
  // Translate to EdgeBM25 format
  const rankedDocs: RankedDocument[] = docs.map(d => ({
    id: d.id,
    docId: d.id,
    title: "",
    text: d.content
  }));
  const bm25 = new EdgeBM25(rankedDocs);
  const scores = bm25.score(query);
  return scores.map(s => ({
    id: docs[s.docIndex]!.id,
    score: s.score
  }));
}
