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

/**
 * CF AI's real embedding response.
 *
 * `data` is a flat array of vectors — `number[][]` — NOT `Array<{embedding}>`. This was declared
 * as the object form, so `item.embedding` was `undefined` for every chunk and Vectorize threw
 * "undefined is not iterable" the moment it tried to read the values. Knowledge-base ingestion
 * had therefore never once succeeded against a real deployment; the test doubles asserted the
 * shape the code expected rather than the shape Cloudflare sends, so nothing caught it.
 *
 * Verified against the live API (`/ai/run/@cf/baai/bge-large-en-v1.5`, shape [2, 1024]).
 * The object form is still accepted, since a different embedding model may well return it and
 * being liberal here costs nothing.
 */
interface AiEmbeddingResponse {
  data: Array<number[] | { embedding: number[] }>;
  shape?: number[];
}

/** Pull the vector out of one entry, whichever of the two shapes it is. */
function vectorOf(item: number[] | { embedding: number[] } | undefined): number[] | null {
  if (Array.isArray(item)) return item;
  if (item && Array.isArray(item.embedding)) return item.embedding;
  return null;
}

const MODEL = "@cf/baai/bge-large-en-v1.5";

/**
 * Embed a single text string.
 * Uses CF AI Workers binding `ai.run()`.
 */
export async function embedText(ai: Ai, text: string): Promise<EmbedResult> {
  const response = await ai.run(MODEL, { text }) as AiEmbeddingResponse;

  const first = vectorOf(response.data?.[0]);
  if (!first) {
    throw new Error("embedText: CF AI returned no usable embedding");
  }

  return {
    embedding: first,
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
      const vector = vectorOf(response.data[j]);
      const text = batch[j];
      // Fail here, loudly, rather than passing an undefined vector down to Vectorize — that is
      // what turned a bad response into an opaque "undefined is not iterable" three layers away.
      if (!vector || text === undefined) {
        throw new Error(`embedBatch: missing or malformed embedding at index ${i + j}`);
      }
      results.push({
        embedding: vector,
        tokenCount: Math.ceil(text.length / 4),
      });
    }
  }

  return results;
}
