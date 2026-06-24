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
const SENTENCE_BOUNDARIES = [". ", "! ", "? ", "\n\n"];

/**
 * Split text into overlapping chunks at sentence boundaries.
 * Returns an array of chunk strings.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const chunkSize = (opts.chunkSize ?? 512) * CHARS_PER_TOKEN;
  const overlap = (opts.overlap ?? 50) * CHARS_PER_TOKEN;

  if (!text || text.trim().length === 0) return [];

  // First pass: split text into sentence-level segments
  const sentences = splitIntoSentences(text);

  const chunks: string[] = [];
  let currentChunk = "";
  let overlapBuffer = "";

  for (const sentence of sentences) {
    const candidate = currentChunk.length === 0 ? sentence : currentChunk + sentence;

    if (candidate.length <= chunkSize) {
      currentChunk = candidate;
    } else {
      // currentChunk is full — save it (if large enough)
      if (currentChunk.length >= MIN_CHUNK_CHARS) {
        chunks.push(currentChunk.trimEnd());
        // Compute overlap: take trailing `overlap` chars of the current chunk
        overlapBuffer = currentChunk.length > overlap
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
      if (prev !== undefined) {
        chunks[chunks.length - 1] = prev + " " + currentChunk.trim();
      }
    } else {
      chunks.push(currentChunk.trimEnd());
    }
  }

  const filtered = chunks.filter(c => c.trim().length >= MIN_CHUNK_CHARS);
  // If everything was filtered (e.g. text shorter than MIN_CHUNK_CHARS), return all non-empty chunks
  return filtered.length > 0 ? filtered : chunks.filter(c => c.trim().length > 0);
}

/**
 * Split text into sentence segments, preserving the delimiter as part of the segment.
 */
function splitIntoSentences(text: string): string[] {
  // Normalise line endings
  const normalised = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const results: string[] = [];
  let remaining = normalised;

  while (remaining.length > 0) {
    let splitIdx = -1;
    let splitLen = 0;

    // Find earliest sentence boundary
    for (const boundary of SENTENCE_BOUNDARIES) {
      const idx = remaining.indexOf(boundary);
      if (idx !== -1 && (splitIdx === -1 || idx < splitIdx)) {
        splitIdx = idx;
        splitLen = boundary.length;
      }
    }

    if (splitIdx === -1) {
      // No more boundaries — treat remainder as one segment
      results.push(remaining);
      break;
    }

    const segment = remaining.slice(0, splitIdx + splitLen);
    if (segment.length > 0) results.push(segment);
    remaining = remaining.slice(splitIdx + splitLen);
  }

  return results;
}

/**
 * Force-split a string that exceeds chunkSize into character-based sub-chunks.
 * Used only when a sentence itself is too long.
 */
function forceChunk(text: string, chunkSize: number, overlap: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));
    start = end - overlap;
    if (start >= text.length) break;
  }
  return chunks;
}
