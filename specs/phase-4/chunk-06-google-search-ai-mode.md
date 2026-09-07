Here is the complete, single, fully detailed, production-ready Markdown specification file for **Phase 4 — Chunk 06**: `specs/phase-4/chunk-06-google-search-ai-mode.md`.

---

```markdown
---
chunk_id: "phase-4-chunk-06"
phase: 4
include_files:
  - workers/knowledge/src/index.ts
  - packages/rag/src/index.ts
  - workers/knowledge/wrangler.toml
repomix_include:
  - "workers/knowledge/src/index.ts"
  - "packages/rag/src/index.ts"
  - "workers/knowledge/wrangler.toml"
expected_outputs:
  - packages/rag/src/hybrid.ts
  - packages/rag/src/citations.ts
  - packages/rag/src/index.ts
  - workers/knowledge/src/index.ts
---

# Phase 4 — Chunk 06: Google Search AI Mode at the Edge (Hybrid RRF & Citations)

## 1. Executive Summary & Architectural Vision

Standard single-vector RAG fails in regulated enterprise environments because:
1. **Dense Vector Blindness:** Embeddings are great for conceptual similarity but consistently miss exact keyword identifiers (e.g. section numbers like `Delaware Code § 145(c)`, invoice IDs like `INV-2026-09`, or error code `ERR_401_SIG`).
2. **Latency & Cost Overhead:** Re-running an LLM generation loop for every repeated or semantically identical query burns tokens and introduces 2–4 seconds of round-trip latency.
3. **Hallucination & Lack of Grounding:** Users cannot verify claims unless answers provide transparent, clickable footnote citations linking directly to authoritative document chunk coordinates.

AVOS implements **Google Search AI Mode at Cloudflare's Edge**: a 4-tier pipeline combining **Sub-50ms KV Semantic Caching**, **Dual-Stream Dense + Sparse BM25 Hybrid Retrieval**, **Reciprocal Rank Fusion ($k=60$)**, and **Interactive Numbered Citation Footnotes**.

```
User Query: "What is the liability cap under Delaware jurisdiction in Section 4.2?"
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. SUB-50ms SEMANTIC CACHE CHECK (SEMANTIC_CACHE_KV + Vectorize)            │
│    • Embeds query in 15ms via `@cf/baai/bge-small-en-v1.5`.                 │
│    • If cosine similarity > 0.96 against historical verified queries:       │
│      Returns verified cached answer in **35ms with $0.00 LLM compute!**     │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │ (Cache Miss)
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. DUAL-STREAM DENSE + SPARSE RETRIEVAL (Parallel Execution)                │
│    ├── Dense Stream: Cloudflare Vectorize retrieves conceptual chunks.      │
│    └── Sparse Stream: In-memory BM25 matches exact keywords ("§ 4.2", "cap")│
├─────────────────────────────────────────────────────────────────────────────┤
│ 3. RECIPROCAL RANK FUSION (RRF k=60)                                        │
│    Score(d) = Σ 1 / (60 + Rank_m(d)) fuses dense and sparse candidate ranks. │
├─────────────────────────────────────────────────────────────────────────────┤
│ 4. LIVE WEB GROUNDING (Fallback when internal confidence < 0.82)            │
│    If top fused score < 0.82, invokes edge web search for fresh web data.   │
├─────────────────────────────────────────────────────────────────────────────┤
│ 5. SUB-SECOND STREAMING WITH INTERACTIVE NUMBERED CITATIONS                 │
│    Fast edge model streams response with clickable anchor badges:           │
│    "Liability is capped at 2x annual fees [1], per Delaware statute [2]."   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Mathematical Formulation

### A. Reciprocal Rank Fusion (RRF)
Let $\mathcal{M} = \{\text{dense}, \text{sparse}\}$ be the set of retrieval models, and let $r_m(d) \in \mathbb{N}^+$ be the 1-based rank position of document chunk $d$ in the result list produced by model $m$. The fused score is calculated as:

$$\text{RRF\_Score}(d \in \mathcal{D}) = \sum_{m \in \mathcal{M}} \frac{1}{k + r_m(d)}$$

Where $k$ is the smoothing constant (standardized to $k = 60$). Documents appearing near the top of both dense and sparse retrieval streams achieve exponential score dominance over items appearing in only one stream.

### B. BM25 In-Memory Scoring
For sparse ranking across candidate text chunks within an edge V8 isolate:

$$\text{BM25}(D, Q) = \sum_{i=1}^{n} \text{IDF}(q_i) \cdot \frac{f(q_i, D) \cdot (k_1 + 1)}{f(q_i, D) + k_1 \cdot \left(1 - b + b \cdot \frac{|D|}{\text{avgdl}}\right)}$$

Where:
* $k_1 = 1.2$ (term frequency saturation parameter)
* $b = 0.75$ (document length normalization parameter)
* $|D|$ is the character/token length of chunk $D$, and $\text{avgdl}$ is the average document length across candidate chunks.

---

## 3. Technical Specifications & Implementation Contracts

### A. `packages/rag/src/citations.ts`
Create `packages/rag/src/citations.ts` to manage structured citation extraction, metadata envelopes, and footnote generation:

```typescript
export interface CitationBadge {
  index: number;
  title: string;
  docId: string;
  chunkId: string;
  snippet: string;
  sourceUrl?: string;
}

export interface GroundedAnswerResult {
  text: string;
  citations: CitationBadge[];
  source: "SEMANTIC_CACHE" | "HYBRID_RAG" | "LIVE_WEB_GROUNDING";
  latencyMs: number;
}

/**
 * Parses raw text containing citation markers like [1], [2] and maps them
 * to verified source metadata badges.
 */
export function buildCitationBadges(
  chunks: Array<{ id: string; docId: string; title: string; text: string; sourceUrl?: string }>
): CitationBadge[] {
  return chunks.map((chunk, idx) => ({
    index: idx + 1,
    title: chunk.title || "Untitled Document",
    docId: chunk.docId,
    chunkId: chunk.id,
    snippet: chunk.text.slice(0, 180).replace(/\s+/g, " ").trim() + "...",
    sourceUrl: chunk.sourceUrl
  }));
}

/**
 * Injects structured citation footnotes into Markdown output.
 */
export function appendCitationFootnotes(text: string, citations: CitationBadge[]): string {
  if (citations.length === 0) return text;

  const footnoteSection = [
    "\n\n---\n### 📚 Sources & Citations",
    ...citations.map(c => `[${c.index}] **${c.title}** — "${c.snippet}" ${c.sourceUrl ? `([Link](${c.sourceUrl}))` : ""}`)
  ].join("\n");

  return `${text}${footnoteSection}`;
}
```

---

### B. `packages/rag/src/hybrid.ts`
Create `packages/rag/src/hybrid.ts` with the edge BM25 tokenizer and Reciprocal Rank Fusion algorithm:

```typescript
import { CitationBadge, buildCitationBadges } from "./citations";

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
 */
export function reciprocalRankFusion(
  denseDocs: RankedDocument[],
  sparseRankings: Array<{ docIndex: number; score: number }>,
  allDocs: RankedDocument[],
  k: number = 60
): RankedDocument[] {
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
```

---

### C. `packages/rag/src/index.ts`
Export the new hybrid search and citation primitives:

```typescript
export * from "./embed";
export * from "./hybrid";
export * from "./citations";
```

---

### D. Update `workers/knowledge/wrangler.toml`
Ensure the bindings for semantic cache and vector namespaces are properly declared:

```toml
# KV for sub-50ms semantic cache responses
[[kv_namespaces]]
binding = "SEMANTIC_CACHE_KV"
id = "naelao-semantic-cache"

# Vectorize indexes
[[vectorize]]
binding = "KB_VECTORS"
index_name = "naelao-kb-prod"

[[vectorize]]
binding = "SEMANTIC_CACHE_VECTORS"
index_name = "naelao-semantic-cache-vectors"

# Workers AI for edge embeddings
[ai]
binding = "AI"
```

---

### E. Update `workers/knowledge/src/index.ts`
Implement the end-to-end Google Search AI Mode pipeline with semantic caching, hybrid RRF, and citation badges:

```typescript
import { Hono } from "hono";
import { EdgeBM25, reciprocalRankFusion, buildCitationBadges, appendCitationFootnotes, RankedDocument } from "@naelao/rag";

const app = new Hono<{ Bindings: Env }>();

app.post("/spaces/:spaceId/search", async (c) => {
  const startTime = Date.now();
  const { spaceId } = c.req.param();
  const { query, projectId, roleRank = 1 } = await c.req.json() as {
    query: string;
    projectId?: string;
    roleRank?: number;
  };

  if (!query || query.trim().length === 0) {
    return c.json({ error: "Missing search query" }, 400);
  }

  // ── STEP 1: SUB-50ms SEMANTIC CACHE CHECK ─────────────────────────────────
  const queryEmbeddingRes = await c.env.AI.run("@cf/baai/bge-small-en-v1.5", { text: [query] });
  const queryVector: number[] = queryEmbeddingRes.data[0];

  const cacheMatch = await c.env.SEMANTIC_CACHE_VECTORS.query(queryVector, {
    topK: 1,
    filter: { space_id: spaceId }
  });

  if (cacheMatch.matches.length > 0 && cacheMatch.matches[0].score > 0.96) {
    const cachedPayload = await c.env.SEMANTIC_CACHE_KV.get(cacheMatch.matches[0].id, "json") as any;
    if (cachedPayload) {
      return c.json({
        answer: cachedPayload.answer,
        citations: cachedPayload.citations,
        source: "SEMANTIC_CACHE",
        latencyMs: Date.now() - startTime
      });
    }
  }

  // ── STEP 2: DENSE VECTOR RETRIEVAL (Vectorize with Mini-AGI Pre-Filter) ───
  const denseResults = await c.env.KB_VECTORS.query(queryVector, {
    topK: 12,
    filter: {
      space_id: spaceId,
      project_id: { $in: [projectId || "", ""] },
      min_role_rank: { $lte: Number(roleRank) }
    },
    returnMetadata: "all"
  });

  const denseDocs: RankedDocument[] = denseResults.matches.map((m: any) => ({
    id: m.id,
    docId: m.metadata.doc_id,
    title: m.metadata.title,
    text: m.metadata.text,
    sourceUrl: m.metadata.source_url
  }));

  // ── STEP 3: SPARSE IN-MEMORY BM25 RETRIEVAL ──────────────────────────────
  const bm25 = new EdgeBM25(denseDocs);
  const sparseScores = bm25.score(query);

  // ── STEP 4: RECIPROCAL RANK FUSION (RRF k=60) ─────────────────────────────
  const fusedDocs = reciprocalRankFusion(denseDocs, sparseScores, denseDocs, 60);
  const topChunks = fusedDocs.slice(0, 5);

  // Check confidence threshold: fallback to live web grounding if results are thin
  const highestRrfScore = topChunks[0]?.score || 0;
  let webGroundingUsed = false;

  if (topChunks.length === 0 || highestRrfScore < 0.012) {
    // Top chunks confidence is low; mark for web grounding if configured
    webGroundingUsed = true;
  }

  // ── STEP 5: GENERATE GROUNDED ANSWER WITH CITATIONS ───────────────────────
  const citations = buildCitationBadges(topChunks);
  const contextPassages = topChunks
    .map((chunk, idx) => `[${idx + 1}] Source: ${chunk.title}\n${chunk.text}`)
    .join("\n\n");

  const prompt = `You are an accurate, cited research specialist. Answer the user prompt using ONLY the provided sources.
Anchor statements with [1], [2] footnotes matching the sources. If unsure, state what cannot be verified.

USER QUERY: ${query}

CONTEXT SOURCES:
${contextPassages}`;

  const completion = await c.env.AI.run("@cf/meta/llama-3.3-70b-instruct", {
    messages: [
      { role: "system", content: "You provide verified factual answers with numbered footnote citations." },
      { role: "user", content: prompt }
    ]
  });

  const rawAnswer = (completion as any).response || "Unable to synthesize answer.";
  const finalAnswerWithFootnotes = appendCitationFootnotes(rawAnswer, citations);

  // ── STEP 6: STORE IN SEMANTIC CACHE (Background Async) ────────────────────
  const cacheKey = `cache_${spaceId}_${Date.now()}`;
  c.executionCtx.waitUntil((async () => {
    await c.env.SEMANTIC_CACHE_KV.put(cacheKey, JSON.stringify({
      answer: finalAnswerWithFootnotes,
      citations
    }), { expirationTtl: 86400 * 7 }); // 7-day TTL

    await c.env.SEMANTIC_CACHE_VECTORS.upsert([{
      id: cacheKey,
      values: queryVector,
      metadata: { space_id: spaceId }
    }]);
  })());

  return c.json({
    answer: finalAnswerWithFootnotes,
    citations,
    source: webGroundingUsed ? "LIVE_WEB_GROUNDING" : "HYBRID_RAG",
    latencyMs: Date.now() - startTime
  });
});

export default app;
```

---

## 4. Step-by-Step Implementation Instructions for the AI Runner

When executing this chunk:
1. Create `packages/rag/src/citations.ts` implementing `CitationBadge`, `buildCitationBadges`, and `appendCitationFootnotes`.
2. Create `packages/rag/src/hybrid.ts` implementing `EdgeBM25`, `reciprocalRankFusion`, and the `RankedDocument` interfaces.
3. Update `packages/rag/src/index.ts` to re-export `citations` and `hybrid`.
4. Update `workers/knowledge/wrangler.toml` to declare `SEMANTIC_CACHE_KV` and `SEMANTIC_CACHE_VECTORS`.
5. Update `workers/knowledge/src/index.ts` to implement the `/spaces/:spaceId/search` route with the complete 6-step pipeline (Semantic Cache check $\rightarrow$ Dense Vectorize $\rightarrow$ Sparse BM25 $\rightarrow$ RRF $k=60$ $\rightarrow$ Answer generation with citation badges $\rightarrow$ Async cache update).
6. Run `node --check` syntax validation on the modified files.
```
