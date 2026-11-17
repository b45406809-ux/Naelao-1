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
    }))).resolves.toBe("## Slide 1\nFirst slide\nBody\n\n## Slide 2\nSecond & last");
  });

  it("rejects missing slides, malformed XML and entity expansion", async () => {
    await expect(parseKnowledgePptx(zipSync({ "ppt/presentation.xml": new TextEncoder().encode("<p:presentation/>") })))
      .rejects.toThrow("knowledge_pptx_slides_missing");
    await expect(parseKnowledgePptx(pptx({ 1: "<!DOCTYPE x [<!ENTITY e SYSTEM 'https://bad.test/'>]><p:sld><a:t>&e;</a:t></p:sld>" })))
      .rejects.toThrow("knowledge_pptx_xml_invalid");
    await expect(parseKnowledgePptx(pptx({ 1: "<p:sld><a:p><a:t>&external;</a:t></a:p></p:sld>" })))
      .rejects.toThrow("knowledge_pptx_xml_invalid");
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
