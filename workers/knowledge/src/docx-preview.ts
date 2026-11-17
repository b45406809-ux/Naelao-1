import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";

export const KNOWLEDGE_DOCX_PARSER_VERSION = "naelao:docx-main-body-v1";
export const MAX_KNOWLEDGE_DOCX_BYTES = 5 * 1024 * 1024;
const MAX_DOCX_ENTRIES = 512;
const MAX_DOCX_XML_BYTES = 4 * 1024 * 1024;
const MAX_DOCX_TEXT_CHARS = 1_048_576;

function decodeXmlText(value: string): string {
  if (value.replace(/&[^;\s]{1,32};/g, "").includes("&")) throw new Error("knowledge_docx_xml_invalid");
  const decoded = value.replace(/&([^;\s]{1,32});/g, (_match, entity: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (!entity.startsWith("#")) {
      const result = named[entity];
      if (result === undefined) throw new Error("knowledge_docx_xml_invalid");
      return result;
    }
    const codePoint = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    if (!Number.isInteger(codePoint) || codePoint < 1 || codePoint > 0x10ffff || codePoint >= 0xd800 && codePoint <= 0xdfff)
      throw new Error("knowledge_docx_xml_invalid");
    return String.fromCodePoint(codePoint);
  });
  return decoded;
}

function extractMainBodyText(xml: string): string {
  if (xml.length > MAX_DOCX_XML_BYTES || /<!DOCTYPE|<!ENTITY/i.test(xml)
    || !/<w:document\b/i.test(xml) || !/<w:body\b/i.test(xml) || !/<\/w:document\s*>/i.test(xml))
    throw new Error("knowledge_docx_xml_invalid");
  const token = /<[^>]{1,4096}>|[^<]+/g;
  let inText = false;
  let headingPrefix = "";
  let wroteHeading = false;
  let tableDepth = 0;
  let output = "";
  for (const match of xml.matchAll(token)) {
    const item = match[0];
    if (item[0] !== "<") {
      if (inText) {
        const decoded = decodeXmlText(item);
        const prefix = !wroteHeading && headingPrefix ? `${headingPrefix} ` : "";
        if (output.length + prefix.length + decoded.length > MAX_DOCX_TEXT_CHARS) throw new Error("knowledge_docx_text_too_large");
        output += prefix + decoded;
        if (prefix) wroteHeading = true;
      }
    } else if (/^<w:p(?:\s|>)/i.test(item)) {
      headingPrefix = "";
      wroteHeading = false;
    } else if (/^<w:pStyle\b/i.test(item)) {
      const heading = /\bw:val=["']Heading([1-6])["']/i.exec(item)?.[1];
      if (heading) headingPrefix = "#".repeat(Number(heading));
    } else if (/^<w:tbl(?:\s|>)/i.test(item)) tableDepth++;
    else if (/^<\/w:tbl\s*>/i.test(item)) tableDepth = Math.max(0, tableDepth - 1);
    else if (/^<w:t(?:\s|>)/i.test(item)) inText = true;
    else if (/^<\/w:t\s*>/i.test(item)) inText = false;
    else if (/^<w:tab\b|^<w:tc\b/i.test(item) && /\/>$/.test(item)) output += "\t";
    else if (/^<\/w:tc\s*>/i.test(item)) output += "\t";
    else if (/^<w:br\b|^<w:cr\b/i.test(item) || /^<\/w:p\s*>/i.test(item) && tableDepth === 0 || /^<\/w:tr\s*>/i.test(item)) output += "\n";
    if (output.length > MAX_DOCX_TEXT_CHARS) throw new Error("knowledge_docx_text_too_large");
  }
  const text = output.replace(/[\t ]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) throw new Error("knowledge_docx_text_empty");
  return text;
}

/**
 * Extracts the OOXML document body only. ZIP paths are never written to storage, unselected
 * entries are not decompressed, XML external entities are rejected, and the selected stream is
 * bounded independently of the archive's declared uncompressed sizes.
 */
export async function parseKnowledgeDocx(bytes: Uint8Array): Promise<string> {
  if (!bytes.byteLength) throw new Error("knowledge_docx_empty");
  if (bytes.byteLength > MAX_KNOWLEDGE_DOCX_BYTES) throw new Error("knowledge_docx_archive_too_large");
  const chunks: Uint8Array[] = [];
  let textBytes = 0;
  let entries = 0;
  let foundDocument = false;
  let failure: Error | null = null;
  let finishDocument!: () => void;
  let failDocument!: (error: Error) => void;
  const documentDone = new Promise<void>((resolve, reject) => { finishDocument = resolve; failDocument = reject; });
  const unzip = new Unzip((file) => {
    entries++;
    if (entries > MAX_DOCX_ENTRIES) { failure = new Error("knowledge_docx_archive_entries_exceeded"); return; }
    if (file.name.length > 256 || file.name.includes("..") || file.name.includes("\\") || file.name.startsWith("/")) {
      failure = new Error("knowledge_docx_archive_path_invalid"); return;
    }
    if (file.name !== "word/document.xml") return;
    if (foundDocument) { failure = new Error("knowledge_docx_document_duplicate"); return; }
    foundDocument = true;
    if (file.originalSize !== undefined && file.originalSize > MAX_DOCX_XML_BYTES) {
      failure = new Error("knowledge_docx_xml_too_large"); return;
    }
    file.ondata = (error, chunk, final) => {
      if (error) { failure = new Error("knowledge_docx_archive_invalid"); failDocument(failure); return; }
      if (chunk) {
        textBytes += chunk.byteLength;
        if (textBytes > MAX_DOCX_XML_BYTES) {
          failure = new Error("knowledge_docx_xml_too_large");
          void file.terminate();
          failDocument(failure);
          return;
        }
        chunks.push(chunk);
      }
      if (final) finishDocument();
    };
    try { file.start(); } catch { failure = new Error("knowledge_docx_archive_invalid"); failDocument(failure); }
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  try { unzip.push(bytes, true); }
  catch { throw new Error("knowledge_docx_archive_invalid"); }
  if (failure) throw failure;
  if (!foundDocument) throw new Error("knowledge_docx_document_missing");
  await documentDone;
  const xml = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(concatChunks(chunks, textBytes));
  return extractMainBodyText(xml);
}

function concatChunks(chunks: Uint8Array[], size: number): Uint8Array {
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}
