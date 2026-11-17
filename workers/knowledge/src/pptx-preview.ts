import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";

export const KNOWLEDGE_PPTX_PARSER_VERSION = "naelao:pptx-slide-text-table-v2";
export const MAX_KNOWLEDGE_PPTX_BYTES = 5 * 1024 * 1024;
const MAX_PPTX_ENTRIES = 512;
const MAX_PPTX_SLIDES = 100;
const MAX_PPTX_SLIDE_XML_BYTES = 1024 * 1024;
const MAX_PPTX_XML_BYTES = 4 * 1024 * 1024;
const MAX_PPTX_TEXT_CHARS = 1_048_576;
const MAX_PPTX_TABLE_ROWS = 256;
const MAX_PPTX_TABLE_COLUMNS = 64;
const MAX_PPTX_TABLE_CELLS = 20_000;

function decodeXmlText(value: string): string {
  if (value.replace(/&[^;\s]{1,32};/g, "").includes("&")) throw new Error("knowledge_pptx_xml_invalid");
  return value.replace(/&([^;\s]{1,32});/g, (_match, entity: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (!entity.startsWith("#")) {
      const decoded = named[entity];
      if (decoded === undefined) throw new Error("knowledge_pptx_xml_invalid");
      return decoded;
    }
    const codePoint = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    if (!Number.isInteger(codePoint) || codePoint < 1 || codePoint > 0x10ffff || codePoint >= 0xd800 && codePoint <= 0xdfff)
      throw new Error("knowledge_pptx_xml_invalid");
    return String.fromCodePoint(codePoint);
  });
}

function extractSlide(xml: string, slideNumber: number, tableCellBudget: { count: number }): string {
  if (xml.length > MAX_PPTX_SLIDE_XML_BYTES || /<!DOCTYPE|<!ENTITY/i.test(xml)
    || !/<(?:\w+:)?sld\b/i.test(xml) || !/<\/(?:\w+:)?sld\s*>/i.test(xml))
    throw new Error("knowledge_pptx_xml_invalid");
  const paragraphs: string[] = [];
  const tableBlocks: string[] = [];
  let tableNumber = 0;
  const textIn = (fragment: string) => [...fragment.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t\s*>/gi)]
    .map((match) => decodeXmlText(match[1]!)).join("");
  const withoutTables = xml.replace(/<(?:\w+:)?tbl\b[^>]*>[\s\S]*?<\/(?:\w+:)?tbl\s*>/gi, (tableXml) => {
    tableNumber++;
    const rows = [...tableXml.matchAll(/<(?:\w+:)?tr\b[^>]*>([\s\S]*?)<\/(?:\w+:)?tr\s*>/gi)];
    if (!rows.length) throw new Error("knowledge_pptx_table_invalid");
    if (rows.length > MAX_PPTX_TABLE_ROWS) throw new Error("knowledge_pptx_table_rows_exceeded");
    const renderedRows: string[] = [];
    for (const [rowIndex, row] of rows.entries()) {
      const cells = [...row[1]!.matchAll(/<(?:\w+:)?tc\b[^>]*>([\s\S]*?)<\/(?:\w+:)?tc\s*>/gi)];
      if (!cells.length || cells.length > MAX_PPTX_TABLE_COLUMNS) throw new Error("knowledge_pptx_table_columns_exceeded");
      tableCellBudget.count += cells.length;
      if (tableCellBudget.count > MAX_PPTX_TABLE_CELLS) throw new Error("knowledge_pptx_table_cells_exceeded");
      renderedRows.push(`Row ${rowIndex + 1}: ${cells.map((cell, cellIndex) => {
        const value = textIn(cell[1]!).replace(/\s+/g, " ").trim();
        return `Cell ${cellIndex + 1}=${JSON.stringify(value)}`;
      }).join(" | ")}`);
    }
    tableBlocks.push(`### Table ${tableNumber}\n\n${renderedRows.join("\n")}`);
    return " ".repeat(tableXml.length);
  });
  let total = 0;
  for (const paragraph of withoutTables.matchAll(/<(?:\w+:)?p\b[^>]*>([\s\S]*?)<\/(?:\w+:)?p\s*>/gi)) {
    const text = textIn(paragraph[1]!);
    if (!text.trim()) continue;
    total += text.length;
    if (total > MAX_PPTX_TEXT_CHARS) throw new Error("knowledge_pptx_text_too_large");
    paragraphs.push(text);
  }
  if (!paragraphs.length && !tableBlocks.length) return "";
  return [`## Slide ${slideNumber}`, paragraphs.join("\n"), ...tableBlocks].filter(Boolean).join("\n\n");
}

async function readSlides(bytes: Uint8Array): Promise<Map<number, string>> {
  const found = new Map<number, string>();
  const seenSlides = new Set<number>();
  let entries = 0;
  let totalXmlBytes = 0;
  const tableCellBudget = { count: 0 };
  let failure: Error | null = null;
  const pending: Promise<void>[] = [];
  const unzip = new Unzip((file) => {
    entries++;
    if (entries > MAX_PPTX_ENTRIES) { failure = new Error("knowledge_pptx_entries_exceeded"); return; }
    if (file.name.length > 256 || file.name.includes("..") || file.name.includes("\\") || file.name.startsWith("/")) {
      failure = new Error("knowledge_pptx_archive_path_invalid"); return;
    }
    const match = /^ppt\/slides\/slide([1-9][0-9]{0,2})\.xml$/i.exec(file.name);
    if (!match) return;
    const slideNumber = Number(match[1]);
    if (slideNumber > MAX_PPTX_SLIDES) { failure = new Error("knowledge_pptx_slides_exceeded"); return; }
    if (seenSlides.has(slideNumber)) { failure = new Error("knowledge_pptx_duplicate_slide"); return; }
    seenSlides.add(slideNumber);
    if (file.originalSize !== undefined && file.originalSize > MAX_PPTX_SLIDE_XML_BYTES) {
      failure = new Error("knowledge_pptx_slide_too_large"); return;
    }
    const chunks: Uint8Array[] = [];
    let partBytes = 0;
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
      file.ondata = (error, chunk, final) => {
        if (error) { failure = new Error("knowledge_pptx_archive_invalid"); resolve(); return; }
        if (chunk) {
          partBytes += chunk.byteLength; totalXmlBytes += chunk.byteLength;
          if (partBytes > MAX_PPTX_SLIDE_XML_BYTES || totalXmlBytes > MAX_PPTX_XML_BYTES) {
            failure = new Error("knowledge_pptx_xml_too_large"); void file.terminate(); resolve(); return;
          }
          chunks.push(chunk);
        }
        if (final) {
          const merged = new Uint8Array(partBytes);
          let offset = 0;
          for (const part of chunks) { merged.set(part, offset); offset += part.length; }
          try {
            const xml = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(merged);
            if (!failure) found.set(slideNumber, extractSlide(xml, slideNumber, tableCellBudget));
          } catch (error) { failure = error instanceof Error ? error : new Error("knowledge_pptx_xml_invalid"); }
          resolve();
        }
      };
    });
    pending.push(done);
    try { file.start(); } catch { failure = new Error("knowledge_pptx_archive_invalid"); settle(); }
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  try { unzip.push(bytes, true); } catch { throw new Error("knowledge_pptx_archive_invalid"); }
  if (failure) throw failure;
  await Promise.all(pending);
  if (failure) throw failure;
  return found;
}

export async function parseKnowledgePptx(bytes: Uint8Array): Promise<string> {
  if (!bytes.byteLength) throw new Error("knowledge_pptx_empty");
  if (bytes.byteLength > MAX_KNOWLEDGE_PPTX_BYTES) throw new Error("knowledge_pptx_archive_too_large");
  const slides = await readSlides(bytes);
  if (!slides.size) throw new Error("knowledge_pptx_slides_missing");
  const text = [...slides.entries()].sort(([a], [b]) => a - b).map(([, content]) => content).filter(Boolean).join("\n\n");
  if (!text) throw new Error("knowledge_pptx_text_missing");
  if (text.length > MAX_PPTX_TEXT_CHARS) throw new Error("knowledge_pptx_text_too_large");
  return text;
}
