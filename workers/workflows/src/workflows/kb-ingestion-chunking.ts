import { chunkStructuredMarkdown, chunkTextWithOffsets, type StructuralChunk, type TextChunkWithOffsets } from "@naelao/rag";

export type IngestionChunk = TextChunkWithOffsets | StructuralChunk;

/** Parsed Office/PDF previews are structured Markdown and keep headings/table source offsets. */
export function chunkKnowledgeText(text: string, contentType: string): IngestionChunk[] {
  return ["pdf", "docx", "xlsx", "pptx"].includes(contentType)
    ? chunkStructuredMarkdown(text)
    : chunkTextWithOffsets(text);
}
