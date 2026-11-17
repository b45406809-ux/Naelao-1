import { describe, expect, it } from "vitest";
import { encodeKnowledgePdfBytes, readKnowledgePdfFile } from "./knowledge-pdf-preview";

describe("Knowledge PDF source selection", () => {
  it("base64-encodes binary bytes without UTF-8 conversion", () => {
    expect(encodeKnowledgePdfBytes(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff]))).toBe("JVBERi0A/w==");
  });

  it("accepts only an in-scope PDF with a PDF header", async () => {
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1])], "guide.pdf", { type: "application/pdf" });
    await expect(readKnowledgePdfFile(file)).resolves.toBe("JVBERi0B");
    await expect(readKnowledgePdfFile(file, "project-1")).resolves.toBe("JVBERi0B");
    const wrongHeader = new File(["not a pdf"], "guide.pdf", { type: "application/pdf" });
    await expect(readKnowledgePdfFile(wrongHeader)).rejects.toThrow("valid PDF");
    const wrongType = new File(["%PDF-1"], "guide.txt", { type: "text/plain" });
    await expect(readKnowledgePdfFile(wrongType)).rejects.toThrow("Choose a PDF");
  });

  it("accepts a bounded XLSX archive only with its matching filename and MIME", async () => {
    const file = new File([new Uint8Array([0x50, 0x4b, 3, 4, 1])], "guide.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    await expect(readKnowledgePdfFile(file)).resolves.toBe("UEsDBAE=");
    const wrongHeader = new File(["not zip"], "guide.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    await expect(readKnowledgePdfFile(wrongHeader)).rejects.toThrow("Office archive");
    const wrongType = new File([new Uint8Array([0x50, 0x4b, 3, 4, 1])], "guide.xlsx", { type: "application/zip" });
    await expect(readKnowledgePdfFile(wrongType)).rejects.toThrow("Choose a PDF");
  });

  it("accepts a bounded PPTX archive only with its matching filename and MIME", async () => {
    const file = new File([new Uint8Array([0x50, 0x4b, 3, 4, 1])], "deck.pptx", {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
    await expect(readKnowledgePdfFile(file)).resolves.toBe("UEsDBAE=");
    const wrongHeader = new File(["not zip"], "deck.pptx", { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });
    await expect(readKnowledgePdfFile(wrongHeader)).rejects.toThrow("Office archive");
    const wrongType = new File([new Uint8Array([0x50, 0x4b, 3, 4, 1])], "deck.pptx", { type: "application/zip" });
    await expect(readKnowledgePdfFile(wrongType)).rejects.toThrow("Choose a PDF");
  });

  it("keeps PDF source bytes under the Space and Project upload ceilings", async () => {
    const spaceOversized = new File([new Uint8Array(1_048_577)], "large.pdf", { type: "application/pdf" });
    const projectOversized = new File([new Uint8Array(5 * 1_048_576 + 1)], "large.pdf", { type: "application/pdf" });
    await expect(readKnowledgePdfFile(spaceOversized)).rejects.toThrow("Space-wide Knowledge files are limited to 1 MiB");
    await expect(readKnowledgePdfFile(projectOversized, "project-1")).rejects.toThrow("Project Knowledge files are limited to 5 MiB");
  });
});
