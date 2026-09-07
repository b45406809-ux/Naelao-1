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
