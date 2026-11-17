import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";

export const KNOWLEDGE_XLSX_PARSER_VERSION = "naelao:xlsx-first-sheet-v1";
export const MAX_KNOWLEDGE_XLSX_BYTES = 5 * 1024 * 1024;
const MAX_XLSX_ENTRIES = 512;
const MAX_XLSX_PART_BYTES = 4 * 1024 * 1024;
const MAX_XLSX_XML_BYTES = 8 * 1024 * 1024;
const MAX_XLSX_TEXT_CHARS = 1_048_576;
const MAX_XLSX_ROWS = 10_000;
const MAX_XLSX_COLUMNS = 256;

function decodeXmlText(value: string): string {
  if (value.replace(/&[^;\s]{1,32};/g, "").includes("&")) throw new Error("knowledge_xlsx_xml_invalid");
  return value.replace(/&([^;\s]{1,32});/g, (_match, entity: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (!entity.startsWith("#")) {
      const decoded = named[entity];
      if (decoded === undefined) throw new Error("knowledge_xlsx_xml_invalid");
      return decoded;
    }
    const codePoint = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    if (!Number.isInteger(codePoint) || codePoint < 1 || codePoint > 0x10ffff || codePoint >= 0xd800 && codePoint <= 0xdfff)
      throw new Error("knowledge_xlsx_xml_invalid");
    return String.fromCodePoint(codePoint);
  });
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/g)) result[match[1]!] = decodeXmlText(match[3]!);
  return result;
}

function safeXml(value: string): string {
  if (value.length > MAX_XLSX_PART_BYTES || /<!DOCTYPE|<!ENTITY/i.test(value)) throw new Error("knowledge_xlsx_xml_invalid");
  return value;
}

function decodeTextTags(value: string): string {
  return [...value.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t\s*>/gi)]
    .map((match) => decodeXmlText(match[1]!)).join("");
}

function parseFirstSheetPath(workbookXml: string, relsXml: string): string {
  safeXml(workbookXml); safeXml(relsXml);
  const sheet = /<(?:\w+:)?sheet\b[^>]*\br:id\s*=\s*(["'])(.*?)\1[^>]*\/?\s*>/i.exec(workbookXml);
  if (!sheet) throw new Error("knowledge_xlsx_sheet_missing");
  const relationId = decodeXmlText(sheet[2]!);
  let target: string | undefined;
  for (const relation of relsXml.matchAll(/<(?:\w+:)?Relationship\b[^>]*\/?\s*>/gi)) {
    const attrs = attributes(relation[0]);
    if (attrs.Id === relationId && /\/worksheet$/i.test(attrs.Type ?? "")) { target = attrs.Target; break; }
  }
  if (!target || target.includes("\\") || target.includes("..") || target.includes("%") || target.includes("?"))
    throw new Error("knowledge_xlsx_sheet_path_invalid");
  const normalized = target.startsWith("/") ? target.slice(1) : target.startsWith("xl/") ? target : `xl/${target}`;
  if (!/^xl\/worksheets\/[A-Za-z0-9_.-]+\.xml$/i.test(normalized)) throw new Error("knowledge_xlsx_sheet_path_invalid");
  return normalized;
}

function columnIndex(reference: string): number {
  const letters = /^[A-Z]+/i.exec(reference)?.[0];
  if (!letters || !/^[A-Z]+\d+$/i.test(reference)) return -1;
  let value = 0;
  for (const char of letters.toUpperCase()) value = value * 26 + char.charCodeAt(0) - 64;
  return value - 1;
}

function extractSheet(xml: string, sharedStrings: string[]): string {
  safeXml(xml);
  const rows: string[][] = [];
  let textChars = 0;
  for (const rowMatch of xml.matchAll(/<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row\s*>/gi)) {
    if (rows.length >= MAX_XLSX_ROWS) throw new Error("knowledge_xlsx_rows_exceeded");
    const row = Array<string>(MAX_XLSX_COLUMNS).fill("");
    let rowHasCells = false;
    for (const cellMatch of rowMatch[1]!.matchAll(/<(?:\w+:)?c\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?c\s*>|<(?:\w+:)?c\b([^>]*)\s*\/>/gi)) {
      const attrs = attributes(`<c ${cellMatch[1] ?? cellMatch[3] ?? ""}>`);
      const index = columnIndex(attrs.r ?? "");
      if (index < 0 || index >= MAX_XLSX_COLUMNS) throw new Error("knowledge_xlsx_columns_exceeded");
      const cellXml = cellMatch[2] ?? "";
      const formula = /<(?:\w+:)?f(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?f\s*>/i.exec(cellXml)?.[1];
      const value = /<(?:\w+:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?v\s*>/i.exec(cellXml)?.[1];
      let text = "";
      if (formula !== undefined) text = `=${decodeXmlText(formula)}`;
      else if (attrs.t === "s" && value !== undefined) {
        const stringIndex = Number(decodeXmlText(value));
        if (!Number.isSafeInteger(stringIndex) || stringIndex < 0 || stringIndex >= sharedStrings.length)
          throw new Error("knowledge_xlsx_shared_string_invalid");
        text = sharedStrings[stringIndex]!;
      } else if (attrs.t === "inlineStr") text = decodeTextTags(cellXml);
      else if (value !== undefined) text = decodeXmlText(value);
      textChars += text.length;
      if (textChars > MAX_XLSX_TEXT_CHARS) throw new Error("knowledge_xlsx_text_too_large");
      row[index] = text;
      rowHasCells = true;
    }
    if (rowHasCells) {
      let last = row.length - 1;
      while (last >= 0 && row[last] === "") last--;
      rows.push(row.slice(0, last + 1));
    }
  }
  if (!rows.length) throw new Error("knowledge_xlsx_sheet_empty");
  const text = rows.map((row) => row.join("\t")).join("\n");
  if (text.length > MAX_XLSX_TEXT_CHARS) throw new Error("knowledge_xlsx_text_too_large");
  return text;
}

async function readParts(bytes: Uint8Array, wanted: Set<string>): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  let entries = 0;
  let totalXmlBytes = 0;
  const pending: Promise<void>[] = [];
  let failure: Error | null = null;
  const unzip = new Unzip((file) => {
    entries++;
    if (entries > MAX_XLSX_ENTRIES) { failure = new Error("knowledge_xlsx_entries_exceeded"); return; }
    if (file.name.length > 256 || file.name.includes("..") || file.name.includes("\\") || file.name.startsWith("/")) {
      failure = new Error("knowledge_xlsx_archive_path_invalid"); return;
    }
    if (!wanted.has(file.name)) return;
    if (found.has(file.name)) { failure = new Error("knowledge_xlsx_duplicate_part"); return; }
    if (file.originalSize !== undefined && file.originalSize > MAX_XLSX_PART_BYTES) {
      failure = new Error("knowledge_xlsx_part_too_large"); return;
    }
    const chunks: Uint8Array[] = [];
    let partBytes = 0;
    const done = new Promise<void>((resolve, reject) => {
      file.ondata = (error, chunk, final) => {
        if (error) { failure = new Error("knowledge_xlsx_archive_invalid"); reject(failure); return; }
        if (chunk) {
          partBytes += chunk.byteLength; totalXmlBytes += chunk.byteLength;
          if (partBytes > MAX_XLSX_PART_BYTES || totalXmlBytes > MAX_XLSX_XML_BYTES) {
            failure = new Error("knowledge_xlsx_part_too_large"); void file.terminate(); reject(failure); return;
          }
          chunks.push(chunk);
        }
        if (final) {
          const merged = new Uint8Array(partBytes);
          let offset = 0;
          for (const part of chunks) { merged.set(part, offset); offset += part.length; }
          try { found.set(file.name, new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(merged)); resolve(); }
          catch { failure = new Error("knowledge_xlsx_xml_invalid"); reject(failure); }
        }
      };
    });
    pending.push(done);
    try { file.start(); } catch { failure = new Error("knowledge_xlsx_archive_invalid"); }
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  try { unzip.push(bytes, true); } catch { throw new Error("knowledge_xlsx_archive_invalid"); }
  if (failure) throw failure;
  await Promise.all(pending);
  if (failure) throw failure;
  return found;
}

export async function parseKnowledgeXlsx(bytes: Uint8Array): Promise<string> {
  if (!bytes.byteLength) throw new Error("knowledge_xlsx_empty");
  if (bytes.byteLength > MAX_KNOWLEDGE_XLSX_BYTES) throw new Error("knowledge_xlsx_archive_too_large");
  const metadata = await readParts(bytes, new Set(["xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/sharedStrings.xml"]));
  const workbook = metadata.get("xl/workbook.xml");
  const relationships = metadata.get("xl/_rels/workbook.xml.rels");
  if (!workbook || !relationships) throw new Error("knowledge_xlsx_workbook_invalid");
  const worksheetPath = parseFirstSheetPath(workbook, relationships);
  const worksheet = await readParts(bytes, new Set([worksheetPath])).then((parts) => parts.get(worksheetPath));
  if (!worksheet) throw new Error("knowledge_xlsx_sheet_missing");
  const sharedStringsXml = metadata.get("xl/sharedStrings.xml");
  const sharedStrings = sharedStringsXml
    ? [...safeXml(sharedStringsXml).matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si\s*>/gi)].map((match) => decodeTextTags(match[1]!))
    : [];
  if (sharedStrings.length > 100_000) throw new Error("knowledge_xlsx_shared_strings_exceeded");
  return extractSheet(worksheet, sharedStrings);
}
