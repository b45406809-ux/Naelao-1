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

export interface TextChunkWithOffsets {
  content: string;
  /** UTF-16 character offset into the original source text. */
  charOffset: number;
  /** Exclusive UTF-16 character offset into the original source text. */
  charEnd: number;
}

export interface ChunkSourceCoordinates {
  byteStart: number;
  byteEnd: number;
  lineStart: number;
  lineEnd: number;
}

export interface SourceLocatedChunk {
  charOffset: number;
  charEnd: number;
}

const CHARS_PER_TOKEN = 4;
const MIN_CHUNK_CHARS = 100;
const SENTENCE_BOUNDARY_PATTERN = /\. |! |\? |\n\n/g;

interface NormalizedSource {
  text: string;
  /** Maps each normalized UTF-16 boundary back to the original source boundary. */
  sourceOffsets: number[];
}

interface ChunkSegment {
  content: string;
  normalizedStart: number;
  normalizedEnd: number;
}

function normalizeLineEndings(text: string): NormalizedSource {
  const characters: string[] = [];
  const sourceOffsets: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    sourceOffsets.push(index);
    if (character === "\r") {
      characters.push("\n");
      if (text[index + 1] === "\n") index++;
    } else {
      characters.push(character);
    }
  }
  sourceOffsets.push(text.length);
  return { text: characters.join(""), sourceOffsets };
}

/** Sentence segments retain their exact offset in the normalized source. */
function* splitIntoSentences(text: string): Generator<{ text: string; start: number; end: number }> {
  let start = 0;
  SENTENCE_BOUNDARY_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SENTENCE_BOUNDARY_PATTERN.exec(text)) !== null) {
    const end = match.index + match[0].length;
    if (end > start) yield { text: text.slice(start, end), start, end };
    start = end;
  }
  if (start < text.length) yield { text: text.slice(start), start, end: text.length };
}

function isBetweenSurrogatePair(text: string, index: number): boolean {
  return index > 0 && index < text.length
    && /[\uD800-\uDBFF]/.test(text[index - 1] ?? "")
    && /[\uDC00-\uDFFF]/.test(text[index] ?? "");
}

function safeBoundaryBefore(text: string, index: number): number {
  return isBetweenSurrogatePair(text, index) ? index - 1 : index;
}

function forceChunk(text: string, sourceStart: number, chunkSize: number, overlap: number): ChunkSegment[] {
  const chunks: ChunkSegment[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + chunkSize, text.length);
    end = safeBoundaryBefore(text, end);
    if (end <= start) end = Math.min(text.length, start + 2);
    chunks.push({ content: text.slice(start, end), normalizedStart: sourceStart + start, normalizedEnd: sourceStart + end });
    if (end === text.length) break;
    start = safeBoundaryBefore(text, end - overlap);
    if (start <= chunks[chunks.length - 1]!.normalizedStart - sourceStart) start = end;
  }
  return chunks;
}

/**
 * Split text into overlapping chunks and preserve exact source coordinates.
 * Character limits approximate provider tokens (4 characters per token), as
 * in the existing synchronous Knowledge path.
 */
export function chunkTextWithOffsets(text: string, opts: ChunkOptions = {}): TextChunkWithOffsets[] {
  const tokenChunkSize = opts.chunkSize ?? 512;
  const tokenOverlap = opts.overlap ?? 50;
  if (!Number.isSafeInteger(tokenChunkSize) || tokenChunkSize < 1
    || tokenChunkSize > Math.floor(Number.MAX_SAFE_INTEGER / CHARS_PER_TOKEN)
    || !Number.isSafeInteger(tokenOverlap) || tokenOverlap < 0
    || tokenOverlap > Math.floor(Number.MAX_SAFE_INTEGER / CHARS_PER_TOKEN)
    || tokenOverlap >= tokenChunkSize) {
    throw new RangeError("chunk size must be positive and overlap must be smaller");
  }
  const chunkSize = tokenChunkSize * CHARS_PER_TOKEN;
  const overlap = tokenOverlap * CHARS_PER_TOKEN;
  if (typeof text !== "string") throw new TypeError("chunkText: text must be a string");
  if (!text || text.trim().length === 0) return [];

  const normalized = normalizeLineEndings(text);
  const segments: ChunkSegment[] = [];
  let currentChunk = "";
  let currentStart = 0;
  let currentEnd = 0;
  let overlapBuffer = "";
  let overlapStart = 0;

  for (const sentence of splitIntoSentences(normalized.text)) {
    const candidate = currentChunk.length === 0 ? sentence.text : currentChunk + sentence.text;
    if (candidate.length <= chunkSize) {
      if (currentChunk.length === 0) currentStart = sentence.start;
      currentChunk = candidate;
      currentEnd = sentence.end;
      continue;
    }

    if (currentChunk.length >= MIN_CHUNK_CHARS) {
      const content = currentChunk.trimEnd();
      if (content) segments.push({ content, normalizedStart: currentStart, normalizedEnd: currentStart + content.length });
      const start = currentChunk.length > overlap
        ? safeBoundaryBefore(currentChunk, currentChunk.length - overlap)
        : 0;
      overlapBuffer = currentChunk.slice(start);
      overlapStart = currentStart + start;
    } else {
      overlapBuffer = "";
    }

    currentChunk = overlapBuffer + sentence.text;
    currentStart = overlapBuffer ? overlapStart : sentence.start;
    currentEnd = sentence.end;
    overlapBuffer = "";

    if (currentChunk.length > chunkSize) {
      const forced = forceChunk(currentChunk, currentStart, chunkSize, overlap);
      for (const part of forced.slice(0, -1)) {
        if (part.content.length >= MIN_CHUNK_CHARS) segments.push(part);
      }
      const last = forced.at(-1);
      currentChunk = last?.content ?? "";
      currentStart = last?.normalizedStart ?? currentEnd;
      currentEnd = last?.normalizedEnd ?? currentEnd;
    }
  }

  if (currentChunk.trim().length > 0) {
    const trimmed = currentChunk.trim();
    if (currentChunk.length < MIN_CHUNK_CHARS && segments.length > 0) {
      const previous = segments[segments.length - 1]!;
      if (previous.content.length + 1 + trimmed.length <= chunkSize) {
        previous.content = `${previous.content} ${trimmed}`;
        previous.normalizedEnd = currentEnd;
      } else {
        const content = currentChunk.trimEnd();
        segments.push({ content, normalizedStart: currentStart, normalizedEnd: currentStart + content.length });
      }
    } else {
      const content = currentChunk.trimEnd();
      segments.push({ content, normalizedStart: currentStart, normalizedEnd: currentStart + content.length });
    }
  }

  const filtered = segments.filter((segment, index) =>
    segment.content.trim().length >= MIN_CHUNK_CHARS || index === segments.length - 1);
  const kept = filtered.length > 0 ? filtered : segments.filter((segment) => segment.content.trim().length > 0);
  return kept.map((segment) => ({
    content: segment.content,
    charOffset: normalized.sourceOffsets[segment.normalizedStart] ?? 0,
    charEnd: normalized.sourceOffsets[segment.normalizedEnd] ?? text.length,
  }));
}

/** Split text into overlapping chunks at sentence boundaries. */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  return chunkTextWithOffsets(text, opts).map((chunk) => chunk.content);
}

/** Map UTF-16 source spans to UTF-8 byte and one-based line coordinates in one scan. */
export function chunkSourceCoordinates(
  text: string,
  chunks: readonly SourceLocatedChunk[],
): ChunkSourceCoordinates[] {
  const boundaries = [...new Set(chunks.flatMap((chunk) => [chunk.charOffset, chunk.charEnd]))].sort((a, b) => a - b);
  for (const boundary of boundaries) {
    if (!Number.isSafeInteger(boundary) || boundary < 0 || boundary > text.length) {
      throw new RangeError("chunk source coordinate is outside the source text");
    }
  }
  const coordinates = new Map<number, { byteOffset: number; line: number }>();
  let characterOffset = 0;
  let byteOffset = 0;
  let line = 1;
  for (const boundary of boundaries) {
    while (characterOffset < boundary) {
      const code = text.charCodeAt(characterOffset);
      if (code === 13) {
        byteOffset++;
        characterOffset++;
        line++;
        if (text.charCodeAt(characterOffset) === 10) {
          byteOffset++;
          characterOffset++;
        }
      } else if (code === 10) {
        byteOffset++;
        characterOffset++;
        line++;
      } else if (code >= 0xd800 && code <= 0xdbff && text.charCodeAt(characterOffset + 1) >= 0xdc00
        && text.charCodeAt(characterOffset + 1) <= 0xdfff) {
        byteOffset += 4;
        characterOffset += 2;
      } else {
        // TextEncoder replaces unpaired UTF-16 surrogates with U+FFFD (three bytes).
        byteOffset += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
        characterOffset++;
      }
    }
    coordinates.set(boundary, { byteOffset, line });
  }
  return chunks.map((chunk) => {
    if (!Number.isSafeInteger(chunk.charOffset) || !Number.isSafeInteger(chunk.charEnd)
      || chunk.charOffset < 0 || chunk.charEnd < chunk.charOffset || chunk.charEnd > text.length) {
      throw new RangeError("chunk source span is invalid");
    }
    const start = coordinates.get(chunk.charOffset)!;
    const end = coordinates.get(chunk.charEnd)!;
    return { byteStart: start.byteOffset, byteEnd: end.byteOffset, lineStart: start.line, lineEnd: end.line };
  });
}
