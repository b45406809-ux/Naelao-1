/**
 * Text chunking at sentence boundaries.
 * Target chunk size: 512 tokens (~2048 chars at 4 chars/token)
 * Overlap: 50 tokens (~200 chars)
 * Minimum chunk size: 100 chars
 */

export interface ChunkOptions {
  /** Target chunk size in tokens (approx: chars / 4). Default: 512 */
  chunkSize?: number;
  /** Overlap in tokens. Default: 50 */
  overlap?: number;
}

const CHARS_PER_TOKEN = 4;
const MIN_CHUNK_CHARS = 100;

/** Sentence boundary delimiters — split after these patterns */
const SENTENCE_BOUNDARY_PATTERN = /\. |! |\? |\n\n/g;

/**
 * Split text into overlapping chunks at sentence boundaries.
 * Returns an array of chunk strings.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const tokenChunkSize = opts.chunkSize ?? 512;
  const tokenOverlap = opts.overlap ?? 50;
  if (
    !Number.isSafeInteger(tokenChunkSize) ||
    tokenChunkSize < 1 ||
    tokenChunkSize > Math.floor(Number.MAX_SAFE_INTEGER / CHARS_PER_TOKEN) ||
    !Number.isSafeInteger(tokenOverlap) ||
    tokenOverlap < 0 ||
    tokenOverlap > Math.floor(Number.MAX_SAFE_INTEGER / CHARS_PER_TOKEN) ||
    tokenOverlap >= tokenChunkSize
  ) {
    throw new RangeError(
      "chunk size must be positive and overlap must be smaller"
    );
  }
  const chunkSize = tokenChunkSize * CHARS_PER_TOKEN;
  const overlap = tokenOverlap * CHARS_PER_TOKEN;

  if (!text || text.trim().length === 0) return [];

  // First pass: split text into sentence-level segments
  const chunks: string[] = [];
  let currentChunk = "";
  let overlapBuffer = "";

  for (const sentence of splitIntoSentences(text)) {
    const candidate =
      currentChunk.length === 0 ? sentence : currentChunk + sentence;

    if (candidate.length <= chunkSize) {
      currentChunk = candidate;
    } else {
      // currentChunk is full — save it (if large enough)
      if (currentChunk.length >= MIN_CHUNK_CHARS) {
        chunks.push(currentChunk.trimEnd());
        // Compute overlap: take trailing `overlap` chars of the current chunk
        overlapBuffer =
          currentChunk.length > overlap
            ? currentChunk.slice(currentChunk.length - overlap)
            : currentChunk;
      }
      // Start a new chunk with the overlap buffer + this sentence
      currentChunk = overlapBuffer + sentence;
      overlapBuffer = "";

      // If a single sentence is itself larger than chunkSize, force-split it
      if (currentChunk.length > chunkSize) {
        const forced = forceChunk(currentChunk, chunkSize, overlap);
        // All but last become final chunks
        for (let i = 0; i < forced.length - 1; i++) {
          const fc = forced[i];
          if (fc !== undefined && fc.length >= MIN_CHUNK_CHARS) {
            chunks.push(fc);
          }
        }
        const last = forced[forced.length - 1];
        currentChunk = last !== undefined ? last : "";
      }
    }
  }

  // Final chunk
  if (currentChunk.trim().length > 0) {
    if (currentChunk.length < MIN_CHUNK_CHARS && chunks.length > 0) {
      // Merge tiny trailing chunk with the last chunk
      const prev = chunks[chunks.length - 1];
      if (
        prev !== undefined &&
        prev.length + 1 + currentChunk.trim().length <= chunkSize
      ) {
        chunks[chunks.length - 1] = `${prev} ${currentChunk.trim()}`;
      } else {
        chunks.push(currentChunk.trimEnd());
      }
    } else {
      chunks.push(currentChunk.trimEnd());
    }
  }

  const filtered = chunks.filter(
    (chunk, index) =>
      chunk.trim().length >= MIN_CHUNK_CHARS || index === chunks.length - 1
  );
  // Keep a short final chunk so forced splits do not discard a document tail.
  return filtered.length > 0
    ? filtered
    : chunks.filter((c) => c.trim().length > 0);
}

/**
 * Split text into sentence segments, preserving the delimiter as part of the segment.
 */
function* splitIntoSentences(text: string): Generator<string> {
  // Normalise line endings
  const normalised = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let start = 0;
  SENTENCE_BOUNDARY_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SENTENCE_BOUNDARY_PATTERN.exec(normalised)) !== null) {
    const end = match.index + match[0].length;
    if (end > start) yield normalised.slice(start, end);
    start = end;
  }
  if (start < normalised.length) yield normalised.slice(start);
}

/**
 * Force-split a string that exceeds chunkSize into character-based sub-chunks.
 * Used only when a sentence itself is too long.
 */
function forceChunk(
  text: string,
  chunkSize: number,
  overlap: number
): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start = end - overlap;
  }
  return chunks;
}
