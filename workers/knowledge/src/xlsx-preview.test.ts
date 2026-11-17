import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { MAX_KNOWLEDGE_XLSX_BYTES, parseKnowledgeXlsx } from "./xlsx-preview.js";

function xlsx(sheet: string, options: { relationship?: string; sharedStrings?: string } = {}): Uint8Array {
  return zipSync({
    "xl/workbook.xml": strToU8('<workbook xmlns:r="x"><sheets><sheet name="Inventory" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    "xl/_rels/workbook.xml.rels": strToU8(options.relationship ?? '<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    "xl/worksheets/sheet1.xml": strToU8(sheet),
    ...(options.sharedStrings ? { "xl/sharedStrings.xml": strToU8(options.sharedStrings) } : {}),
  });
}

describe("parseKnowledgeXlsx", () => {
  it("extracts the first worksheet as text, resolving shared strings and displaying formulas without cached results", async () => {
    const bytes = xlsx('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Count</t></is></c></row><row r="2"><c r="A2"><v>001</v></c><c r="B2"><f>SUM(B3:B4)</f><v>7</v></c></row></sheetData></worksheet>', {
      sharedStrings: "<sst><si><t>SKU</t></si></sst>",
    });
    await expect(parseKnowledgeXlsx(bytes)).resolves.toBe("SKU\tCount\n001\t=SUM(B3:B4)");
  });

  it("rejects unsafe worksheet targets, external entities and malformed workbook contracts", async () => {
    await expect(parseKnowledgeXlsx(xlsx("<worksheet/>", { relationship: '<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="../secret.xml"/></Relationships>' })))
      .rejects.toThrow("knowledge_xlsx_sheet_path_invalid");
    await expect(parseKnowledgeXlsx(xlsx('<!DOCTYPE x [<!ENTITY e SYSTEM "https://bad.test/">]><worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>&e;</t></is></c></row></sheetData></worksheet>')))
      .rejects.toThrow("knowledge_xlsx_xml_invalid");
    await expect(parseKnowledgeXlsx(zipSync({ "xl/worksheets/sheet1.xml": strToU8("<worksheet/>") })))
      .rejects.toThrow("knowledge_xlsx_workbook_invalid");
  });

  it("bounds source bytes, XML parts, rows and worksheet columns", async () => {
    await expect(parseKnowledgeXlsx(new Uint8Array(MAX_KNOWLEDGE_XLSX_BYTES + 1))).rejects.toThrow("knowledge_xlsx_archive_too_large");
    const tooManyRows = `<worksheet><sheetData>${"<row><c r=\"A1\"><v>x</v></c></row>".repeat(10_001)}</sheetData></worksheet>`;
    await expect(parseKnowledgeXlsx(xlsx(tooManyRows))).rejects.toThrow("knowledge_xlsx_rows_exceeded");
    await expect(parseKnowledgeXlsx(xlsx("<worksheet><sheetData><row><c r=\"JA1\"><v>x</v></c></row></sheetData></worksheet>")))
      .rejects.toThrow("knowledge_xlsx_columns_exceeded");
  });
});
