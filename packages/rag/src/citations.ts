export interface CitationCoordinate {
  r2Key: string;
  byteStart: number;
  byteEnd: number;
  lineStart?: number;
  lineEnd?: number;
}

export interface CitationCandidate extends CitationCoordinate {
  docId: string;
  title: string;
  snippet: string;
  url?: string;
}

export interface NumberedCitation {
  index: number;
  title: string;
  docId: string;
  snippet: string;
  url: string;
  r2Key: string;
  charOffset: number;
}

/** Attach stable numeric badges to cited chunk tokens (e.g. [[doc:abc]]), and return the
 * independently renderable footnote metadata. Unreferenced candidates are not exposed. */
export function formatNumberedCitations(chunks: CitationCandidate[], responseText: string): {
  text: string;
  citations: NumberedCitation[];
} {
  const citations: NumberedCitation[] = [];
  const byDoc = new Map<string, NumberedCitation>();
  const text = responseText.replace(/\[\[doc:([^\]]+)\]\]/g, (token, docId: string) => {
    const chunk = chunks.find((item) => item.docId === docId);
    if (!chunk) return "";
    let citation = byDoc.get(docId);
    if (!citation) {
      citation = { index: citations.length + 1, title: chunk.title, docId, snippet: chunk.snippet,
        url: chunk.url ?? `/citations/${encodeURIComponent(docId)}`, r2Key: chunk.r2Key,
        charOffset: chunk.byteStart };
      citations.push(citation);
      byDoc.set(docId, citation);
    }
    return `[${citation.index}]`;
  });
  return { text, citations };
}

/** Rejects forged keys/ranges before an R2 read. The expected key is derived from authoritative
 * document state rather than accepted from the model or browser. */
export function verifyCitationCoordinate(
  proposed: CitationCoordinate,
  accessible: { r2Key: string; size: number; lineCount?: number }
): CitationCoordinate {
  if (proposed.r2Key !== accessible.r2Key)
    throw new Error("citation key is not accessible");
  if (
    !Number.isSafeInteger(proposed.byteStart) ||
    !Number.isSafeInteger(proposed.byteEnd) ||
    proposed.byteStart < 0 ||
    proposed.byteEnd <= proposed.byteStart ||
    proposed.byteEnd > accessible.size
  ) {
    throw new Error("citation byte range is invalid");
  }
  if (proposed.lineStart !== undefined || proposed.lineEnd !== undefined) {
    const lineStart = proposed.lineStart;
    const lineEnd = proposed.lineEnd;
    if (
      lineStart === undefined ||
      lineEnd === undefined ||
      !Number.isSafeInteger(lineStart) ||
      !Number.isSafeInteger(lineEnd) ||
      lineStart < 1 ||
      lineEnd < lineStart ||
      (accessible.lineCount !== undefined && lineEnd > accessible.lineCount)
    ) {
      throw new Error("citation line range is invalid");
    }
  }
  return proposed;
}

/** Numbering is based only on the immutable citation identity, so partial stream re-renders do
 * not renumber an already displayed badge. */
export function stableCitationNumbers(
  citations: CitationCoordinate[]
): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const citation of citations) {
    const identity = `${citation.r2Key}:${citation.byteStart}:${citation.byteEnd}:${citation.lineStart ?? ""}:${citation.lineEnd ?? ""}`;
    if (!numbers.has(identity)) numbers.set(identity, numbers.size + 1);
  }
  return numbers;
}
