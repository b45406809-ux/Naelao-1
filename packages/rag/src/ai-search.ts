/**
 * Cloudflare AI Search & AutoRAG Managed Ingestion Engine
 *
 * Implements:
 * 1. Cloudflare AI Search client for automated RAG with built-in hybrid search & reranking
 * 2. Continuous ingestion for R2 workspace files, documents, and company knowledge vault
 * 3. Numbered citation generator ([1], [2], [3]) for "Google Search AI Mode" answers
 * 4. Zero-cost embeddings and Workers AI reranker integration
 */

export interface AiSearchBinding {
  query(options: {
    query: string;
    filter?: Record<string, unknown>;
    topK?: number;
    rerank?: boolean;
    includeMetadata?: boolean;
  }): Promise<{
    results: Array<{
      id: string;
      score: number;
      text?: string;
      content?: string;
      metadata?: Record<string, unknown>;
    }>;
  }>;
}

export interface AiSearchQueryOptions {
  query: string;
  filter?: {
    space_id?: string;
    project_id?: string | null;
    visibility?: string;
    min_role_rank?: number;
    tags?: string[];
    [key: string]: unknown;
  };
  topK?: number;
  rerank?: boolean;
  generateCitations?: boolean;
}

export interface AiSearchCitation {
  index: number;
  docId: string;
  title: string;
  snippet: string;
  url?: string;
  score: number;
}

export interface AiSearchResponse {
  results: Array<{
    id: string;
    docId: string;
    title: string;
    content: string;
    score: number;
    metadata?: Record<string, unknown>;
  }>;
  citations: AiSearchCitation[];
  citationFootnotes: string;
  latencyMs: number;
  engine: "cloudflare_ai_search" | "hybrid_fallback";
}

/**
 * Format search results with inline citation footnotes e.g. [1], [2]
 */
export function formatAiSearchCitations(citations: AiSearchCitation[]): string {
  if (citations.length === 0) return "";
  return citations
    .map((c) => `[${c.index}] ${c.title || "Document " + c.docId}: "${c.snippet.slice(0, 160)}..."${c.url ? ` (${c.url})` : ""}`)
    .join("\n");
}

/**
 * Cloudflare AI Search Client
 * Manages queries against Cloudflare's native AI Search instance with seamless fallback.
 */
export class CloudflareAiSearchClient {
  constructor(
    private readonly binding?: AiSearchBinding,
    private readonly fallbackRunner?: (query: string, filter?: Record<string, unknown>, topK?: number) => Promise<Array<{ id: string; docId: string; title: string; content: string; score: number; metadata?: Record<string, unknown> }>>
  ) {}

  async search(options: AiSearchQueryOptions): Promise<AiSearchResponse> {
    const startTime = Date.now();
    const topK = options.topK ?? 6;

    if (this.binding) {
      try {
        const raw = await this.binding.query({
          query: options.query,
          filter: options.filter,
          topK,
          rerank: options.rerank !== false,
          includeMetadata: true,
        });

        const items = raw.results.map((r, i) => {
          const docId = String(r.metadata?.["doc_id"] || r.id.split("_")[0] || r.id);
          const title = String(r.metadata?.["title"] || r.metadata?.["name"] || `Document ${i + 1}`);
          const content = String(r.content || r.text || r.metadata?.["content_preview"] || "");
          return {
            id: r.id,
            docId,
            title,
            content,
            score: r.score,
            metadata: r.metadata,
          };
        });

        const citations: AiSearchCitation[] = items.map((item, idx) => ({
          index: idx + 1,
          docId: item.docId,
          title: item.title,
          snippet: item.content.slice(0, 200).replace(/\s+/g, " ").trim(),
          url: typeof item.metadata?.["url"] === "string" ? item.metadata["url"] : undefined,
          score: item.score,
        }));

        return {
          results: items,
          citations,
          citationFootnotes: formatAiSearchCitations(citations),
          latencyMs: Date.now() - startTime,
          engine: "cloudflare_ai_search",
        };
      } catch (err) {
        console.warn("[ai-search] Native AI search query failed, falling back to hybrid RAG:", err);
      }
    }

    if (this.fallbackRunner) {
      const fallbackResults = await this.fallbackRunner(options.query, options.filter, topK);
      const citations: AiSearchCitation[] = fallbackResults.map((item, idx) => ({
        index: idx + 1,
        docId: item.docId,
        title: item.title,
        snippet: item.content.slice(0, 200).replace(/\s+/g, " ").trim(),
        url: typeof item.metadata?.["url"] === "string" ? (item.metadata["url"] as string) : undefined,
        score: item.score,
      }));

      return {
        results: fallbackResults,
        citations,
        citationFootnotes: formatAiSearchCitations(citations),
        latencyMs: Date.now() - startTime,
        engine: "hybrid_fallback",
      };
    }

    return {
      results: [],
      citations: [],
      citationFootnotes: "",
      latencyMs: Date.now() - startTime,
      engine: "cloudflare_ai_search",
    };
  }
}

/**
 * Continuous Background Ingestion Engine
 * Watches and synchronizes workspace files, markdown docs, and company PDFs into AI Search.
 */
export class ContinuousIngestionEngine {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly aiSearchInstanceName?: string
  ) {}

  /**
   * Sync a workspace document to R2 for continuous AI Search indexation.
   */
  async syncDocument(params: {
    spaceId: string;
    projectId?: string | null;
    docId: string;
    title: string;
    content: string;
    contentType?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ key: string; indexed: boolean }> {
    const key = `autorag/${params.spaceId}/${params.projectId ?? "_space"}/${params.docId}.md`;
    const headerMeta = `---\ntitle: ${params.title}\nspace_id: ${params.spaceId}\nproject_id: ${params.projectId ?? ""}\ndoc_id: ${params.docId}\n---\n\n`;
    const fullBody = headerMeta + params.content;

    await this.bucket.put(key, fullBody, {
      customMetadata: {
        space_id: params.spaceId,
        project_id: params.projectId ?? "",
        doc_id: params.docId,
        title: params.title,
        updated_at: new Date().toISOString(),
        ...(params.metadata ? { custom: JSON.stringify(params.metadata) } : {}),
      },
    });

    return {
      key,
      indexed: Boolean(this.aiSearchInstanceName),
    };
  }

  /**
   * Batch ingest files (e.g. 500 PDFs or Notion markdown exports) into AI Search vault.
   */
  async batchIngestFiles(
    files: Array<{
      spaceId: string;
      projectId?: string | null;
      docId: string;
      title: string;
      content: string;
    }>
  ): Promise<{ ingestedCount: number; errors: string[] }> {
    let count = 0;
    const errors: string[] = [];

    for (const f of files) {
      try {
        await this.syncDocument(f);
        count++;
      } catch (err) {
        errors.push(`Failed to ingest ${f.docId}: ${(err as Error).message}`);
      }
    }

    return { ingestedCount: count, errors };
  }
}
