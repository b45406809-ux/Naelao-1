import { getDocumentProxy } from "unpdf";

export const DOCUMENT_FILE_MAX_SOURCE_BYTES = 10 * 1024 * 1024;
// Keep the full JSON partition manifest below the durable workflow artifact cap even when the
// extracted text is rich in JSON-escaped characters such as quotes or newlines.
export const DOCUMENT_FILE_MAX_TEXT_BYTES = 1536 * 1024;
export const DOCUMENT_FILE_MAX_PDF_PAGES = 100;
export const DOCUMENT_PARTITION_CHARS = 64_000;

export interface ExtractedDocumentFile {
  text: string;
  mimeType: string;
  sourceBytes: number;
  pages?: string[];
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assertTextLimit(value: string): void {
  if (byteLength(value) > DOCUMENT_FILE_MAX_TEXT_BYTES)
    throw new Error("document_extracted_text_too_large");
}

/** Extract text only from bounded, non-executable document formats. Scanned PDFs need the
 * separate, owner-enabled OCR path; this function never guesses at image content. */
export async function extractPartitionableDocument(input: {
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
}): Promise<ExtractedDocumentFile> {
  const { bytes } = input;
  if (!bytes.byteLength || bytes.byteLength > DOCUMENT_FILE_MAX_SOURCE_BYTES)
    throw new Error("document_source_size_limit");
  const mimeType = input.mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
  if (
    mimeType === "application/pdf" ||
    input.filename.toLowerCase().endsWith(".pdf")
  ) {
    if (
      !new TextDecoder("latin1")
        .decode(bytes.subarray(0, Math.min(1024, bytes.length)))
        .includes("%PDF-")
    )
      throw new Error("document_pdf_header_invalid");
    let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
    try {
      pdf = await getDocumentProxy(bytes, {
        enableXfa: false,
        maxImageSize: 0,
        useSystemFonts: false,
      });
      if (pdf.numPages > DOCUMENT_FILE_MAX_PDF_PAGES)
        throw new Error("document_pdf_page_limit");
      const pages: string[] = [];
      let totalBytes = 0;
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const reader = (await pdf.getPage(pageNumber))
          .streamTextContent({ includeMarkedContent: false })
          .getReader();
        const parts: string[] = [];
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            for (const item of value.items) {
              if (!("str" in item) || typeof item.str !== "string") continue;
              const part = item.str + (item.hasEOL ? "\n" : "");
              totalBytes += byteLength(part);
              if (totalBytes > DOCUMENT_FILE_MAX_TEXT_BYTES)
                throw new Error("document_extracted_text_too_large");
              parts.push(part);
            }
          }
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
        pages.push(parts.join(""));
      }
      if (pages.every((page) => !page.trim()))
        throw new Error("document_pdf_has_no_extractable_text");
      return {
        text: pages.join("\n\n"),
        pages,
        mimeType,
        sourceBytes: bytes.byteLength,
      };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("document_"))
        throw error;
      const pdfError = error as { name?: string; code?: number };
      if (
        pdfError?.name === "PasswordException" ||
        pdfError?.code === 1 ||
        pdfError?.code === 2
      )
        throw new Error("document_pdf_encrypted");
      throw new Error("document_pdf_malformed");
    } finally {
      await pdf?.loadingTask.destroy().catch(() => undefined);
    }
  }
  const acceptedText =
    /^(?:text\/(?:plain|csv|markdown|xml)|application\/(?:json|xml))$/;
  if (
    !acceptedText.test(mimeType) &&
    !/\.(?:txt|csv|md|json|xml)$/i.test(input.filename)
  )
    throw new Error("document_format_unsupported");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes
    );
  } catch {
    throw new Error("document_text_encoding_unsupported");
  }
  assertTextLimit(text);
  if (!text.trim() || text.includes("\0"))
    throw new Error("document_text_invalid");
  return {
    text,
    mimeType: mimeType || "text/plain",
    sourceBytes: bytes.byteLength,
  };
}

export function partitionDocumentText(input: {
  text: string;
  pages?: string[];
  maxChunks?: number;
}): Array<{
  index: number;
  text: string;
  start: number;
  end: number;
  page?: number;
  offsetEncoding: "utf16";
}> {
  const chunks: Array<{
    index: number;
    text: string;
    start: number;
    end: number;
    page?: number;
    offsetEncoding: "utf16";
  }> = [];
  const sourcePages = input.pages ?? [input.text];
  let globalOffset = 0;
  for (let pageIndex = 0; pageIndex < sourcePages.length; pageIndex++) {
    const page = sourcePages[pageIndex] ?? "";
    for (let start = 0; start < page.length; ) {
      let end = Math.min(page.length, start + DOCUMENT_PARTITION_CHARS);
      if (end < page.length && /[\uD800-\uDBFF]/.test(page.charAt(end - 1)))
        end--;
      // Prefer a nearby paragraph or sentence boundary without allowing a pathological tiny chunk.
      if (end < page.length && end - start > DOCUMENT_PARTITION_CHARS * 0.7) {
        const boundary = Math.max(
          page.lastIndexOf("\n\n", end),
          page.lastIndexOf("\n", end),
          page.lastIndexOf(". ", end)
        );
        if (boundary > start + DOCUMENT_PARTITION_CHARS * 0.7)
          end = boundary + (page[boundary] === "." ? 1 : 0);
      }
      const text = page.slice(start, end);
      chunks.push({
        index: chunks.length,
        text,
        start: globalOffset + start,
        end: globalOffset + end,
        ...(input.pages ? { page: pageIndex + 1 } : {}),
        offsetEncoding: "utf16",
      });
      start = end;
    }
    globalOffset += page.length + (pageIndex + 1 < sourcePages.length ? 2 : 0);
  }
  if (!chunks.length || chunks.length > (input.maxChunks ?? 24))
    throw new Error("document_partition_count_limit");
  return chunks;
}
