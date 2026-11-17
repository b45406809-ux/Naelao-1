import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { MAX_KNOWLEDGE_DOCX_BYTES, parseKnowledgeDocx } from "./docx-preview.js";

function docx(documentXml: string, extra: Record<string, string> = {}): Uint8Array {
  return zipSync({ "word/document.xml": strToU8(documentXml), ...Object.fromEntries(Object.entries(extra).map(([name, value]) => [name, strToU8(value)])) });
}

describe("parseKnowledgeDocx", () => {
  it("keeps headings, paragraph order, table columns, numeric strings and formulas as text", async () => {
    const xml = `<w:document xmlns:w="x"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Stock</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>SKU</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Count</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>001</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>=SUM(A1:A2) &amp; rest</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`;
    await expect(parseKnowledgeDocx(docx(xml))).resolves.toBe("# Stock\nSKU\tCount\n001\t=SUM(A1:A2) & rest");
  });

  it("rejects missing document parts, unsafe XML entities and external entity declarations", async () => {
    await expect(parseKnowledgeDocx(zipSync({ "word/styles.xml": strToU8("<styles/>") })))
      .rejects.toThrow("knowledge_docx_document_missing");
    await expect(parseKnowledgeDocx(docx("<w:document><w:body><w:p><w:r><w:t>&external;</w:t></w:r></w:p></w:body></w:document>")))
      .rejects.toThrow("knowledge_docx_xml_invalid");
    await expect(parseKnowledgeDocx(docx("<!DOCTYPE x [<!ENTITY e SYSTEM 'https://bad.test/'>]><w:document><w:body><w:p><w:t>&e;</w:t></w:p></w:body></w:document>")))
      .rejects.toThrow("knowledge_docx_xml_invalid");
  });

  it("limits compressed upload size, extracted XML and archive entry count", async () => {
    await expect(parseKnowledgeDocx(new Uint8Array(MAX_KNOWLEDGE_DOCX_BYTES + 1))).rejects.toThrow("knowledge_docx_archive_too_large");
    const tooLargeXml = `<w:document><w:body><w:p><w:t>${"x".repeat(4 * 1024 * 1024 + 1)}</w:t></w:p></w:body></w:document>`;
    await expect(parseKnowledgeDocx(docx(tooLargeXml))).rejects.toThrow("knowledge_docx_xml_too_large");
    const entries = Object.fromEntries(Array.from({ length: 513 }, (_, index) => [`word/unused-${index}.xml`, strToU8("")]));
    await expect(parseKnowledgeDocx(zipSync({ "word/document.xml": strToU8("<w:document><w:body><w:p><w:t>x</w:t></w:p></w:body></w:document>"), ...entries })))
      .rejects.toThrow("knowledge_docx_archive_entries_exceeded");
  });
});
