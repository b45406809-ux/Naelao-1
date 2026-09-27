export interface StructuralChunk {
  content: string;
  charOffset: number;
  charEnd: number;
  headingPath: string[];
}

/** Chunk Markdown without separating a heading from its body or splitting a pipe table. */
export function chunkStructuredMarkdown(markdown: string, maxChars = 2_048): StructuralChunk[] {
  if (!markdown.trim()) return [];
  const blocks = markdown.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  const result: StructuralChunk[] = [];
  const headings: string[] = [];
  let pending = "";
  let pendingOffset = 0;

  const emit = () => {
    const content = pending.trimEnd();
    if (content) result.push({ content, charOffset: pendingOffset, charEnd: pendingOffset + content.length, headingPath: [...headings] });
    pending = "";
  };
  let searchFrom = 0;
  for (const block of blocks) {
    const offset = markdown.indexOf(block, searchFrom);
    searchFrom = Math.max(searchFrom, offset + block.length);
    const heading = /^(#{1,6})\s+(.+)$/m.exec(block);
    if (heading?.[1] && heading[2]) {
      emit();
      headings.splice(heading[1].length - 1);
      headings[heading[1].length - 1] = heading[2].trim();
    }
    if (pending && pending.length + block.length + 2 > maxChars) emit();
    if (!pending) pendingOffset = Math.max(0, offset);
    // A table is an atomic block. Oversized tables deliberately exceed maxChars rather than
    // destroying row/column semantics.
    pending += `${pending ? "\n\n" : ""}${block}`;
  }
  emit();
  return result;
}
