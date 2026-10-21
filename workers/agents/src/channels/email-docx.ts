import { Unzip, UnzipInflate, UnzipPassThrough, type UnzipFile } from "fflate";

export const EMAIL_DOCX_MAX_BYTES = 1024 * 1024;
export const EMAIL_DOCX_MAX_ENTRIES = 128;
export const EMAIL_DOCX_MAX_XML_BYTES = 256 * 1024;
export const EMAIL_DOCX_MAX_TEXT_BYTES = 64 * 1024;
const EMAIL_DOCX_MAX_DECLARED_TOTAL_BYTES = 4 * 1024 * 1024;
const DOCUMENT_XML = "word/document.xml";

export type EmailDocxErrorCode =
  | "attachment_docx_too_large"
  | "attachment_docx_archive_limit"
  | "attachment_docx_xml_limit"
  | "attachment_docx_text_limit"
  | "attachment_docx_malformed";

export class EmailDocxError extends Error {
  constructor(readonly code: EmailDocxErrorCode) {
    super(code);
    this.name = "EmailDocxError";
  }
}

function decodeXmlText(value: string): string {
  return value
    .replace(
      /&(#x[0-9a-f]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos);/gi,
      (entity, name: string) => {
        if (name === "amp") return "&";
        if (name === "lt") return "<";
        if (name === "gt") return ">";
        if (name === "quot") return '"';
        if (name === "apos") return "'";
        const codePoint =
          name[1]?.toLowerCase() === "x"
            ? Number.parseInt(name.slice(2), 16)
            : Number.parseInt(name.slice(1), 10);
        if (
          !Number.isInteger(codePoint) ||
          codePoint < 0 ||
          codePoint > 0x10ffff ||
          (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ) {
          throw new EmailDocxError("attachment_docx_malformed");
        }
        return String.fromCodePoint(codePoint);
      }
    )
    .replace(/&[^;\s]{1,32};/g, () => {
      throw new EmailDocxError("attachment_docx_malformed");
    });
}

/** Extract Word paragraph text only. No relationships, links, macros, embedded objects, or XML
 * external entities are followed or executed. Input XML has already been bounded by the ZIP reader. */
export function extractDocxDocumentText(xml: string): string {
  const documentXml = xml.replace(/<!--[\s\S]*?-->/g, "");
  if (
    xml.length > EMAIL_DOCX_MAX_XML_BYTES ||
    documentXml.includes("<!--") ||
    documentXml.includes("-->") ||
    /<!\s*(?:DOCTYPE|ENTITY)/i.test(documentXml) ||
    /&(?!(?:#x[0-9a-f]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos);)/i.test(
      documentXml
    ) ||
    !/<w:document\b/.test(documentXml) ||
    !/<\/w:document\s*>/.test(documentXml)
  ) {
    throw new EmailDocxError(
      xml.length > EMAIL_DOCX_MAX_XML_BYTES
        ? "attachment_docx_xml_limit"
        : "attachment_docx_malformed"
    );
  }
  const output: string[] = [];
  let outputBytes = 0;
  const paragraphs = documentXml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p\s*>/g);
  for (const paragraph of paragraphs) {
    const pieces: string[] = [];
    for (const item of paragraph[1]!.matchAll(
      /<w:t\b[^>]*>([\s\S]*?)<\/w:t\s*>|<w:(tab|br|cr)\b[^>]*\/>/g
    )) {
      if (item[1] !== undefined) pieces.push(decodeXmlText(item[1]));
      else if (item[2] === "tab") pieces.push("\t");
      else pieces.push("\n");
    }
    const line = pieces.join("");
    const byteLength =
      new TextEncoder().encode(line).byteLength + (output.length ? 1 : 0);
    outputBytes += byteLength;
    if (outputBytes > EMAIL_DOCX_MAX_TEXT_BYTES)
      throw new EmailDocxError("attachment_docx_text_limit");
    output.push(line);
  }
  return output.join("\n");
}

/** Stream only `word/document.xml` from a bounded DOCX ZIP. Other members are counted but never
 * decompressed, which avoids expanding images, embedded documents, or macro payloads. */
export async function extractEmailDocxText(
  bytes: Uint8Array
): Promise<{ text: string }> {
  if (bytes.byteLength > EMAIL_DOCX_MAX_BYTES)
    throw new EmailDocxError("attachment_docx_too_large");
  if (bytes.byteLength < 22)
    throw new EmailDocxError("attachment_docx_malformed");

  let entries = 0;
  let declaredBytes = 0;
  let targetCount = 0;
  let targetComplete = false;
  let targetChunks: Uint8Array[] = [];
  let targetBytes = 0;
  let failure: EmailDocxError | undefined;
  const unzip = new Unzip((file) => {
    entries++;
    if (entries > EMAIL_DOCX_MAX_ENTRIES) {
      failure = new EmailDocxError("attachment_docx_archive_limit");
      return;
    }
    if (
      typeof file.originalSize === "number" &&
      Number.isFinite(file.originalSize) &&
      file.originalSize >= 0
    ) {
      declaredBytes += file.originalSize;
      if (declaredBytes > EMAIL_DOCX_MAX_DECLARED_TOTAL_BYTES) {
        failure = new EmailDocxError("attachment_docx_archive_limit");
        return;
      }
    }
    if (file.name !== DOCUMENT_XML) return;
    targetCount++;
    if (targetCount > 1) {
      failure = new EmailDocxError("attachment_docx_malformed");
      return;
    }
    if (
      (typeof file.originalSize === "number" &&
        Number.isFinite(file.originalSize) &&
        file.originalSize > EMAIL_DOCX_MAX_XML_BYTES) ||
      (typeof file.size === "number" &&
        Number.isFinite(file.size) &&
        file.size > EMAIL_DOCX_MAX_BYTES)
    ) {
      failure = new EmailDocxError("attachment_docx_xml_limit");
      return;
    }
    const target = file as UnzipFile;
    target.ondata = (error, chunk, final) => {
      if (error) {
        failure = new EmailDocxError("attachment_docx_malformed");
        return;
      }
      targetBytes += chunk.byteLength;
      if (targetBytes > EMAIL_DOCX_MAX_XML_BYTES) {
        failure = new EmailDocxError("attachment_docx_xml_limit");
        void target.terminate();
        return;
      }
      targetChunks.push(chunk);
      if (final) targetComplete = true;
    };
    try {
      target.start();
    } catch {
      failure = new EmailDocxError("attachment_docx_malformed");
    }
  });
  unzip.register(UnzipPassThrough);
  unzip.register(UnzipInflate);
  try {
    unzip.push(bytes, true);
  } catch {
    if (!failure) failure = new EmailDocxError("attachment_docx_malformed");
  }
  if (failure) throw failure;
  if (targetCount !== 1 || !targetComplete)
    throw new EmailDocxError("attachment_docx_malformed");

  const xmlBytes = new Uint8Array(targetBytes);
  let offset = 0;
  for (const chunk of targetChunks) {
    xmlBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  targetChunks = [];
  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      xmlBytes
    );
  } catch {
    throw new EmailDocxError("attachment_docx_malformed");
  }
  return { text: extractDocxDocumentText(xml) };
}
