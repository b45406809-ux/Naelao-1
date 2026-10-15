import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  EMAIL_PDF_MAX_BYTES,
  EMAIL_PDF_MAX_PAGES,
  EMAIL_PDF_MAX_TEXT_BYTES,
  EmailPdfError,
  appendBoundedPdfTextChunk,
  extractEmailPdfText,
} from "./email-pdf.js";

function pdfFixture(pageCount = 1, pageText = "Fixture page"): Uint8Array {
  const objects: string[] = ["<< /Type /Catalog /Pages 2 0 R >>"];
  const pageIds = Array.from({ length: pageCount }, (_, index) => 3 + index * 2);
  objects.push(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`);
  for (let index = 0; index < pageCount; index++) {
    const pageId = pageIds[index]!;
    const contentId = pageId + 1;
    const stream = `BT /F1 12 Tf 72 720 Td (${pageText} ${index + 1}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${3 + pageCount * 2} 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects.push(`<< /Length ${new TextEncoder().encode(stream).length} >>\nstream\n${stream}\nendstream`);
  }
  const fontId = objects.length + 1;
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const parts = ["%PDF-1.4\n% fixture\n"];
  const offsets = [0];
  let byteOffset = new TextEncoder().encode(parts[0]).length;
  objects.forEach((object, index) => {
    offsets.push(byteOffset);
    const part = `${index + 1} 0 obj\n${object}\nendobj\n`;
    parts.push(part);
    byteOffset += new TextEncoder().encode(part).length;
  });
  const xrefOffset = byteOffset;
  parts.push(`xref\n0 ${fontId + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${fontId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
  return new TextEncoder().encode(parts.join(""));
}

describe("bounded email PDF text extraction", () => {
  it("extracts text from a real PDF byte stream with page provenance", async () => {
    const result = await extractEmailPdfText(pdfFixture(2));
    expect(result.pages).toBe(2);
    expect(result.text).toContain("Fixture page 1");
    expect(result.text).toContain("Fixture page 2");
  });

  it("rejects malformed bytes and PDFs over the page limit", async () => {
    await expect(extractEmailPdfText(new TextEncoder().encode("not a pdf")))
      .rejects.toMatchObject({ code: "attachment_pdf_malformed" });
    await expect(extractEmailPdfText(pdfFixture(EMAIL_PDF_MAX_PAGES + 1)))
      .rejects.toMatchObject({ code: "attachment_pdf_page_limit" });
  });

  it("rejects password-protected PDFs without prompting or attempting a password", async () => {
    const bytes = new Uint8Array(await readFile(new URL("./fixtures/encrypted-email.pdf", import.meta.url)));
    await expect(extractEmailPdfText(bytes)).rejects.toMatchObject({ code: "attachment_pdf_encrypted" });
  });

  it("rejects oversized input before parsing", async () => {
    const oversized = new Uint8Array(EMAIL_PDF_MAX_BYTES + 1);
    await expect(extractEmailPdfText(oversized)).rejects.toBeInstanceOf(EmailPdfError);
    await expect(extractEmailPdfText(oversized)).rejects.toMatchObject({ code: "attachment_pdf_too_large" });
  });

  it("caps extracted text even when a single page expands beyond the output budget", async () => {
    const firstPage = "x".repeat(EMAIL_PDF_MAX_TEXT_BYTES - 1);
    const bytesUsed = appendBoundedPdfTextChunk(firstPage, 0);
    expect(bytesUsed).toBe(EMAIL_PDF_MAX_TEXT_BYTES - 1);
    expect(() => appendBoundedPdfTextChunk("é", bytesUsed)).toThrowError(
      expect.objectContaining({ code: "attachment_pdf_text_limit" }),
    );
  });
});
