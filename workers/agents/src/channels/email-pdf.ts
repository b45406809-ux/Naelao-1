import { getDocumentProxy } from "unpdf";

export const EMAIL_PDF_MAX_BYTES = 1024 * 1024;
export const EMAIL_PDF_MAX_PAGES = 10;
export const EMAIL_PDF_MAX_TEXT_BYTES = 64 * 1024;

export type EmailPdfErrorCode = "attachment_pdf_too_large" | "attachment_pdf_page_limit" | "attachment_pdf_text_limit" | "attachment_pdf_encrypted" | "attachment_pdf_malformed";

export class EmailPdfError extends Error {
  constructor(readonly code: EmailPdfErrorCode) {
    super(code);
    this.name = "EmailPdfError";
  }
}

function hasPdfHeader(bytes: Uint8Array): boolean {
  // PDF permits a small preamble before the header; constrain the scan to the first KiB.
  return new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 1024))).includes("%PDF-");
}

export function appendBoundedPdfTextChunk(pageText: string, bytesUsed: number): number {
  const updatedBytes = bytesUsed + new TextEncoder().encode(pageText).byteLength;
  if (updatedBytes > EMAIL_PDF_MAX_TEXT_BYTES) throw new EmailPdfError("attachment_pdf_text_limit");
  return updatedBytes;
}

/** Extract text only. PDF.js does not execute document scripts or follow links here. */
export async function extractEmailPdfText(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  if (bytes.byteLength > EMAIL_PDF_MAX_BYTES) throw new EmailPdfError("attachment_pdf_too_large");
  if (!hasPdfHeader(bytes)) throw new EmailPdfError("attachment_pdf_malformed");

  let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
  try {
    pdf = await getDocumentProxy(bytes, {
      // This path never renders pages or runs PDF JavaScript. Keep optional active content off.
      enableXfa: false,
      maxImageSize: 0,
      useSystemFonts: false,
    });
    if (pdf.numPages > EMAIL_PDF_MAX_PAGES) throw new EmailPdfError("attachment_pdf_page_limit");

    const pages: string[] = [];
    let bytesUsed = 0;
    let textLimitExceeded = false;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const reader = (await pdf.getPage(pageNumber)).streamTextContent({ includeMarkedContent: false }).getReader();
      const pageParts: string[] = [];
      let streamDone = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            streamDone = true;
            break;
          }
          for (const item of value.items) {
            if (!("str" in item) || typeof item.str !== "string") continue;
            const part = item.str + (item.hasEOL ? "\n" : "");
            const partBytes = new TextEncoder().encode(part).byteLength;
            if (bytesUsed + partBytes > EMAIL_PDF_MAX_TEXT_BYTES) {
              textLimitExceeded = true;
              continue;
            }
            bytesUsed += partBytes;
            if (!textLimitExceeded) pageParts.push(part);
          }
        }
      } finally {
        // PDF.js can race an early stream cancellation against its worker's final close. Continue
        // draining after the output cap instead; cancel only if the stream itself failed early.
        if (!streamDone) await reader.cancel().catch(() => undefined);
      }
      if (pageNumber > 1 && bytesUsed + 2 > EMAIL_PDF_MAX_TEXT_BYTES) textLimitExceeded = true;
      else if (pageNumber > 1) bytesUsed += 2;
      pages.push(pageParts.join(""));
    }
    if (textLimitExceeded) throw new EmailPdfError("attachment_pdf_text_limit");
    return { text: pages.join("\n\n"), pages: pdf.numPages };
  } catch (error) {
    if (error instanceof EmailPdfError) throw error;
    const pdfError = error as { name?: string; code?: number; message?: string };
    if (pdfError?.name === "PasswordException" || pdfError?.code === 1 || pdfError?.code === 2) {
      throw new EmailPdfError("attachment_pdf_encrypted");
    }
    throw new EmailPdfError("attachment_pdf_malformed");
  } finally {
    await pdf?.loadingTask.destroy().catch(() => undefined);
  }
}
