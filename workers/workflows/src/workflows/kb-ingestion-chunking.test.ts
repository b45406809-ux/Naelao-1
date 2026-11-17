import { describe, expect, it } from "vitest";
import { chunkKnowledgeText } from "./kb-ingestion-chunking.js";

describe("Knowledge durable workflow chunking", () => {
  it("preserves PPTX slide headings and text source coordinates", () => {
    const content = "## Slide 3\n\nQuarterly results\n\n## Slide 4\n\nRevenue up 12%";
    const chunks = chunkKnowledgeText(content, "pptx");
    const first = chunks.find((chunk) => chunk.content === "Quarterly results");
    const second = chunks.find((chunk) => chunk.content === "Revenue up 12%");
    expect(first).toMatchObject({ headingPath: ["Slide 3"] });
    expect(second).toMatchObject({ headingPath: ["Slide 4"] });
    expect(content.slice(first!.charOffset, first!.charEnd)).toBe("Quarterly results");
  });
});
