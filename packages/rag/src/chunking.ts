export interface StructuralChunk {
  content: string;
  charOffset: number;
  charEnd: number;
  headingPath: string[];
}

interface SourceBlock {
  content: string;
  start: number;
  end: number;
}

function paragraphBlocks(markdown: string): SourceBlock[] {
  const blocks: SourceBlock[] = [];
  let start = -1;
  let end = 0;
  // Keep source offsets in UTF-16 code units, matching String#indexOf and the
  // Knowledge Worker citation-coordinate implementation.
  for (const match of markdown.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
    const line = match[0];
    if (!line) continue;
    const contentEnd = match.index + line.replace(/(?:\r\n|\n|\r)$/, "").length;
    if (line.trim()) {
      if (start < 0) start = match.index;
      end = contentEnd;
    } else if (start >= 0) {
      blocks.push({ content: markdown.slice(start, end), start, end });
      start = -1;
    }
  }
  if (start >= 0) blocks.push({ content: markdown.slice(start, end), start, end });
  return blocks;
}

function splitAtLimit(text: string, maxChars: number): Array<{ text: string; start: number; end: number }> {
  const parts: Array<{ text: string; start: number; end: number }> = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxChars);
    // Never split a UTF-16 surrogate pair.
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "") && /[\uDC00-\uDFFF]/.test(text[end] ?? "")) end--;
    if (end <= start) end = Math.min(text.length, start + 2);
    if (end < text.length) {
      const boundary = text.lastIndexOf(" ", end);
      if (boundary > start + Math.floor(maxChars * 0.6)) end = boundary;
    }
    parts.push({ text: text.slice(start, end), start, end });
    start = end;
  }
  return parts;
}

function isTable(block: string): boolean {
  const lines = block.split(/\r\n|\n|\r/);
  return lines.length >= 2 && lines[0]?.includes("|") === true && /^\s*\|?\s*:?-{3,}/.test(lines[1] ?? "");
}

function sourceLines(text: string): Array<{ text: string; start: number; end: number }> {
  const lines: Array<{ text: string; start: number; end: number }> = [];
  for (const match of text.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
    const raw = match[0];
    if (!raw) continue;
    const line = raw.replace(/(?:\r\n|\n|\r)$/, "");
    if (line) lines.push({ text: line, start: match.index, end: match.index + line.length });
  }
  return lines;
}

/**
 * Chunk Markdown while retaining headings, table headers, and source offsets.
 * Long tables are split by rows and repeat their header in each chunk; very
 * long individual rows are split at safe character boundaries. No output
 * chunk exceeds maxChars, so an adversarial single table cannot exceed the
 * embedding model's input budget.
 */
export function chunkStructuredMarkdown(markdown: string, maxChars = 2_048): StructuralChunk[] {
  if (typeof markdown !== "string") throw new TypeError("markdown must be a string");
  if (!Number.isSafeInteger(maxChars) || maxChars < 2 || maxChars > 32_768) {
    throw new RangeError("maxChars must be an integer between 2 and 32768");
  }
  if (!markdown.trim()) return [];

  const result: StructuralChunk[] = [];
  const headings: string[] = [];
  const emit = (content: string, charOffset: number, charEnd: number) => {
    if (content.trim()) result.push({ content, charOffset, charEnd, headingPath: [...headings] });
  };

  for (const block of paragraphBlocks(markdown)) {
    const heading = /^(#{1,6})\s+(.+)$/m.exec(block.content);
    if (heading?.[1] && heading[2]) {
      headings.splice(heading[1].length - 1);
      headings[heading[1].length - 1] = heading[2].trim();
    }

    if (isTable(block.content)) {
      const lines = sourceLines(block.content);
      const headerLines = lines.slice(0, 2);
      const header = headerLines.map((line) => line.text).join("\n");
      const rows = lines.slice(2);
      if (rows.length === 0) {
        for (const part of splitAtLimit(header, maxChars)) {
          emit(part.text, block.start + (headerLines[0]?.start ?? 0) + part.start, block.start + (headerLines[0]?.start ?? 0) + part.end);
        }
        continue;
      }
      let group: Array<{ line: string; start: number; end: number }> = [];
      let groupLength = header.length;
      const flush = () => {
        if (!group.length) return;
        const from = group[0]!.start;
        const to = group[group.length - 1]!.end;
        const rowText = group.map((part) => part.line).join("\n");
        emit(`${header}\n${rowText}`, block.start + from, block.start + to);
        group = [];
        groupLength = header.length;
      };

      // Locate each row in the original block, advancing to handle duplicate rows.
      for (const row of rows) {
        const rowParts = row.text.length + 1 + header.length > maxChars
          ? splitAtLimit(row.text, Math.max(1, maxChars - Math.min(header.length + 1, maxChars - 1)))
          : [{ text: row.text, start: 0, end: row.text.length }];
        for (const part of rowParts) {
          const partStart = row.start + part.start;
          const partEnd = row.start + part.end;
          const renderedLength = header.length + 1 + part.text.length;
          if (group.length && groupLength + 1 + part.text.length > maxChars) flush();
          if (renderedLength > maxChars) {
            // If the table header itself exceeds the budget, keep row fragments
            // bounded while preserving their source coordinate spans.
            flush();
            emit(part.text, block.start + partStart, block.start + partEnd);
          } else {
            group.push({ line: part.text, start: partStart, end: partEnd });
            groupLength += 1 + part.text.length;
          }
        }
      }
      flush();
      continue;
    }

    if (block.content.length <= maxChars) {
      emit(block.content, block.start, block.end);
    } else {
      for (const part of splitAtLimit(block.content, maxChars)) {
        emit(part.text, block.start + part.start, block.start + part.end);
      }
    }
  }
  return result;
}
