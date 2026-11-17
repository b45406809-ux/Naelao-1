import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { MAX_KNOWLEDGE_PPTX_BYTES, parseKnowledgePptx } from "./pptx-preview.js";

function pptx(slides: Record<number, string>): Uint8Array {
  const files: Record<string, Uint8Array> = { "ppt/presentation.xml": new TextEncoder().encode("<p:presentation/>") };
  for (const [number, xml] of Object.entries(slides)) files[`ppt/slides/slide${number}.xml`] = new TextEncoder().encode(xml);
  return zipSync(files);
}

describe("bounded PowerPoint Knowledge preview", () => {
  it("extracts slide text in slide and paragraph order while keeping markup inert", async () => {
    await expect(parseKnowledgePptx(pptx({
      2: "<p:sld><a:p><a:r><a:t>Second &amp; last</a:t></a:r></a:p></p:sld>",
      1: "<p:sld><a:p><a:r><a:t>First</a:t></a:r><a:r><a:t> slide</a:t></a:r></a:p><a:p><a:r><a:t>Body</a:t></a:r></a:p></p:sld>",
    }))).resolves.toBe("## Slide 1\n\nFirst slide\nBody\n\n## Slide 2\n\nSecond & last");
  });

  it("rejects missing slides, malformed XML and entity expansion", async () => {
    await expect(parseKnowledgePptx(zipSync({ "ppt/presentation.xml": new TextEncoder().encode("<p:presentation/>") })))
      .rejects.toThrow("knowledge_pptx_slides_missing");
    await expect(parseKnowledgePptx(pptx({ 1: "<!DOCTYPE x [<!ENTITY e SYSTEM 'https://bad.test/'>]><p:sld><a:t>&e;</a:t></p:sld>" })))
      .rejects.toThrow("knowledge_pptx_xml_invalid");
    await expect(parseKnowledgePptx(pptx({ 1: "<p:sld><a:p><a:t>&external;</a:t></a:p></p:sld>" })))
      .rejects.toThrow("knowledge_pptx_xml_invalid");
  });

  it("preserves bounded table cells with explicit slide/table/row/cell coordinates", async () => {
    const xml = `<p:sld><a:p><a:r><a:t>Sales overview</a:t></a:r></a:p><a:graphicFrame><a:tbl>
      <a:tr><a:tc><a:p><a:r><a:t>Product</a:t></a:r></a:p></a:tc><a:tc><a:p><a:r><a:t>Count &amp; value</a:t></a:r></a:p></a:tc></a:tr>
      <a:tr><a:tc><a:p><a:r><a:t>Tea | coffee</a:t></a:r></a:p></a:tc><a:tc><a:p><a:r><a:t>4</a:t></a:r></a:p></a:tc></a:tr>
    </a:tbl></a:graphicFrame></p:sld>`;
    await expect(parseKnowledgePptx(pptx({ 1: xml }))).resolves.toBe(
      `## Slide 1\n\nSales overview\n\n### Table 1\n\nRow 1: Cell 1="Product" | Cell 2="Count & value"\nRow 2: Cell 1="Tea | coffee" | Cell 2="4"`,
    );
  });

  it("rejects excessive table dimensions and total cell work", async () => {
    const row = (columns: number) => `<a:tr>${Array.from({ length: columns }, () => "<a:tc><a:p><a:t>x</a:t></a:p></a:tc>").join("")}</a:tr>`;
    const table = (rows: number, columns: number) => `<p:sld><a:tbl>${Array.from({ length: rows }, () => row(columns)).join("")}</a:tbl></p:sld>`;
    await expect(parseKnowledgePptx(pptx({ 1: table(257, 1) }))).rejects.toThrow("knowledge_pptx_table_rows_exceeded");
    await expect(parseKnowledgePptx(pptx({ 1: table(1, 65) }))).rejects.toThrow("knowledge_pptx_table_columns_exceeded");
    const slides: Record<number, string> = {};
    for (let slide = 1; slide <= 16; slide++) slides[slide] = table(21, 64);
    await expect(parseKnowledgePptx(pptx(slides))).rejects.toThrow("knowledge_pptx_table_cells_exceeded");
  });

  it("caps archive bytes, slide count, total XML and output text", async () => {
    await expect(parseKnowledgePptx(new Uint8Array(MAX_KNOWLEDGE_PPTX_BYTES + 1))).rejects.toThrow("knowledge_pptx_archive_too_large");
    const slides: Record<number, string> = {};
    for (let i = 1; i <= 101; i++) slides[i] = "<p:sld><a:p><a:t>x</a:t></a:p></p:sld>";
    await expect(parseKnowledgePptx(pptx(slides))).rejects.toThrow("knowledge_pptx_slides_exceeded");
    await expect(parseKnowledgePptx(pptx({ 1: `<p:sld><a:p><a:t>${"x".repeat(1_048_577)}</a:t></a:p></p:sld>` })))
      .rejects.toThrow("knowledge_pptx_slide_too_large");
  });
});
