import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import {
  EMAIL_DOCX_MAX_BYTES,
  EMAIL_DOCX_MAX_ENTRIES,
  EMAIL_DOCX_MAX_TEXT_BYTES,
  EmailDocxError,
  extractDocxDocumentText,
  extractEmailDocxText,
} from "./email-docx.js";

const encoder = new TextEncoder();
function docx(xml = "<w:document><w:body><w:p><w:r><w:t>Hello &amp; goodbye</w:t></w:r></w:p></w:body></w:document>", extra: Record<string, string> = {}) {
  return zipSync(Object.fromEntries(Object.entries({ "[Content_Types].xml": "<Types/>", "word/document.xml": xml, ...extra })
    .map(([name, text]) => [name, encoder.encode(text)])), { level: 6 });
}

describe("bounded email DOCX text extraction", () => {
  it("streams only document XML and preserves text with paragraph provenance", async () => {
    const result = await extractEmailDocxText(docx("<w:document><w:body><w:p><w:r><w:t>Hello &amp; world</w:t><w:tab/><w:t>next</w:t><w:br/><w:t>line</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p></w:body></w:document>", {
      "word/media/image.png": "ignored payload",
      "word/embeddings/embedded.docx": "ignored embedded document",
    }));
    expect(result.text).toBe("Hello & world\tnext\nline\nSecond");
  });

  it("rejects invalid XML entities and external entity declarations", () => {
    expect(() => extractDocxDocumentText("<!DOCTYPE w:document [<!ENTITY x SYSTEM 'https://example.test/'>]><w:document></w:document>"))
      .toThrowError(expect.objectContaining({ code: "attachment_docx_malformed" }));
    expect(() => extractDocxDocumentText("<w:document><w:p><w:t>&external;</w:t></w:p></w:document>"))
      .toThrowError(expect.objectContaining({ code: "attachment_docx_malformed" }));
  });

  it("rejects missing or malformed document XML", async () => {
    await expect(extractEmailDocxText(zipSync({ "[Content_Types].xml": encoder.encode("<Types/>") })))
      .rejects.toMatchObject({ code: "attachment_docx_malformed" });
    await expect(extractEmailDocxText(encoder.encode("not a zip archive")))
      .rejects.toMatchObject({ code: "attachment_docx_malformed" });
  });

  it("rejects oversized input, too many archive entries, and expanded document XML", async () => {
    await expect(extractEmailDocxText(new Uint8Array(EMAIL_DOCX_MAX_BYTES + 1)))
      .rejects.toBeInstanceOf(EmailDocxError);
    await expect(extractEmailDocxText(new Uint8Array(EMAIL_DOCX_MAX_BYTES + 1)))
      .rejects.toMatchObject({ code: "attachment_docx_too_large" });
    const manyEntries = Object.fromEntries(Array.from({ length: EMAIL_DOCX_MAX_ENTRIES + 1 }, (_, index) => [`f${index}`, encoder.encode("x")]));
    await expect(extractEmailDocxText(zipSync({ ...manyEntries, "word/document.xml": encoder.encode("<w:document></w:document>") })))
      .rejects.toMatchObject({ code: "attachment_docx_archive_limit" });
    const expanded = docx(`<w:document><w:p><w:t>${"x".repeat(EMAIL_DOCX_MAX_TEXT_BYTES * 5)}</w:t></w:p></w:document>`);
    await expect(extractEmailDocxText(expanded)).rejects.toMatchObject({ code: "attachment_docx_xml_limit" });
  });

  it("caps extracted UTF-8 text size", () => {
    expect(() => extractDocxDocumentText(`<w:document><w:p><w:t>${"é".repeat(EMAIL_DOCX_MAX_TEXT_BYTES)}</w:t></w:p></w:document>`))
      .toThrowError(expect.objectContaining({ code: "attachment_docx_text_limit" }));
  });
});
