/**
 * CF AI Workers embedding using @cf/baai/bge-large-en-v1.5 (dimension: 1024).
 * Runs inside a Cloudflare Worker — uses the Ai binding.
 */

export interface EmbedResult {
  /** 1024-dimensional embedding vector */
  embedding: number[];
  /** Approximate token count (chars / 4) */
  tokenCount: number;
}

// CF AI Workers model response shape
interface AiEmbeddingResponse {
  data: Array<{ embedding: number[] }>;
  shape?: number[];
}

const MODEL = "@cf/baai/bge-large-en-v1.5";

/**
 * Embed a single text string.
 * Uses CF AI Workers binding `ai.run()`.
 */
export async function embedText(ai: Ai, text: string): Promise<EmbedResult> {
  const response = await ai.run(MODEL, { text }) as AiEmbeddingResponse;

  const first = response.data[0];
  if (!first) {
    throw new Error("embedText: CF AI returned empty data array");
  }

  return {
    embedding: first.embedding,
    tokenCount: Math.ceil(text.length / 4),
  };
}

/**
 * Embed multiple texts in one CF AI batch call (supports up to 100 texts at once).
 * Batches automatically if texts.length > 100.
 */
export async function embedBatch(ai: Ai, texts: string[]): Promise<EmbedResult[]> {
  if (texts.length === 0) return [];

  const CF_AI_BATCH_LIMIT = 100;
  const results: EmbedResult[] = [];

  // Process in batches of CF_AI_BATCH_LIMIT
  for (let i = 0; i < texts.length; i += CF_AI_BATCH_LIMIT) {
    const batch = texts.slice(i, i + CF_AI_BATCH_LIMIT);
    const response = await ai.run(MODEL, { text: batch }) as AiEmbeddingResponse;

    if (!response.data || response.data.length !== batch.length) {
      throw new Error(
        `embedBatch: CF AI returned ${response.data?.length ?? 0} embeddings for ${batch.length} texts`
      );
    }

    for (let j = 0; j < batch.length; j++) {
      const item = response.data[j];
      const text = batch[j];
      if (!item || text === undefined) {
        throw new Error(`embedBatch: missing result at index ${i + j}`);
      }
      results.push({
        embedding: item.embedding,
        tokenCount: Math.ceil(text.length / 4),
      });
    }
  }

  return results;
}
