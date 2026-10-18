import { describe, expect, it } from "vitest";
import {
  extractPartitionableDocument,
  partitionDocumentText,
} from "./document-files.js";

function pdfFixture(pageCount = 2, pageText = "Project page"): Uint8Array {
  const objects: string[] = ["<< /Type /Catalog /Pages 2 0 R >>"];
  const pageIds = Array.from(
    { length: pageCount },
    (_, index) => 3 + index * 2
  );
  objects.push(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`
  );
  for (let index = 0; index < pageCount; index++) {
    const pageId = pageIds[index] ?? 0;
    const contentId = pageId + 1;
    const stream = `BT /F1 12 Tf 72 720 Td (${pageText} ${index + 1}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${3 + pageCount * 2} 0 R >> >> /Contents ${contentId} 0 R >>`
    );
    objects.push(
      `<< /Length ${new TextEncoder().encode(stream).length} >>\nstream\n${stream}\nendstream`
    );
  }
  const fontId = objects.length + 1;
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const parts = ["%PDF-1.4\n% fixture\n"];
  const offsets = [0];
  let byteOffset = new TextEncoder().encode(parts[0] ?? "").length;
  objects.forEach((object, index) => {
    offsets.push(byteOffset);
    const part = `${index + 1} 0 obj\n${object}\nendobj\n`;
    parts.push(part);
    byteOffset += new TextEncoder().encode(part).length;
  });
  const xrefOffset = byteOffset;
  parts.push(
    `xref\n0 ${fontId + 1}\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
      .join(
        ""
      )}trailer\n<< /Size ${fontId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`
  );
  return new TextEncoder().encode(parts.join(""));
}

describe("durable document file partitioning", () => {
  it("keeps text complete across bounded chunks and surrogate pairs", () => {
    const text = `${"line\n".repeat(12_900)}😀 tail`;
    const chunks = partitionDocumentText({ text });
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(text);
    expect(
      chunks.every(
        (chunk) => chunk.end > chunk.start && chunk.offsetEncoding === "utf16"
      )
    ).toBe(true);
  });

  it("keeps PDF page provenance while splitting oversized pages", () => {
    const pages = [`${"A".repeat(70_000)}😀`, "Second page"];
    const chunks = partitionDocumentText({ text: pages.join("\n\n"), pages });
    expect(
      chunks
        .filter((chunk) => chunk.page === 1)
        .map((chunk) => chunk.text)
        .join("")
    ).toBe(pages[0]);
    expect(
      chunks
        .filter((chunk) => chunk.page === 2)
        .map((chunk) => chunk.text)
        .join("")
    ).toBe(pages[1]);
    expect(chunks[0]).toMatchObject({ page: 1, start: 0 });
    expect(chunks.at(-1)).toMatchObject({ page: 2, text: "Second page" });
  });

  it("accepts bounded UTF-8 text and rejects unsupported, binary, and oversized sources", async () => {
    await expect(
      extractPartitionableDocument({
        bytes: new TextEncoder().encode("a,b\n1,2"),
        mimeType: "text/csv",
        filename: "rows.csv",
      })
    ).resolves.toMatchObject({ text: "a,b\n1,2", sourceBytes: 7 });
    await expect(
      extractPartitionableDocument({
        bytes: new Uint8Array([0, 255]),
        mimeType: "application/octet-stream",
        filename: "file.bin",
      })
    ).rejects.toThrow("document_format_unsupported");
    await expect(
      extractPartitionableDocument({
        bytes: new Uint8Array([0xff]),
        mimeType: "text/plain",
        filename: "file.txt",
      })
    ).rejects.toThrow("document_text_encoding_unsupported");
    await expect(
      extractPartitionableDocument({
        bytes: new Uint8Array(10 * 1024 * 1024 + 1),
        mimeType: "text/plain",
        filename: "large.txt",
      })
    ).rejects.toThrow("document_source_size_limit");
  });

  it("extracts searchable PDF text and preserves its page identity for workflow chunks", async () => {
    const extracted = await extractPartitionableDocument({
      bytes: pdfFixture(),
      mimeType: "application/pdf",
      filename: "terms.pdf",
    });
    expect(extracted.pages).toHaveLength(2);
    expect(extracted.pages?.[0]).toContain("Project page 1");
    expect(
      partitionDocumentText({
        text: extracted.text,
        pages: extracted.pages,
      }).map((chunk) => chunk.page)
    ).toEqual([1, 2]);
  });

  it("fails when partition metadata would exceed the per-workflow chunk budget", () => {
    expect(() =>
      partitionDocumentText({ text: "x".repeat(64_000 * 34) })
    ).toThrow("document_partition_count_limit");
  });
});
