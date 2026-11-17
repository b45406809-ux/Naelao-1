import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KnowledgeCsvPreview, parseKnowledgeCsvPreview } from "./KnowledgeCsvPreview";

describe("KnowledgeCsvPreview", () => {
  it("preserves quoted delimiters, line breaks, leading zeroes, and formula text", () => {
    const content = 'sku,amount,note\n001,0007,"line one, line two"\n002,=SUM(A1:A2),"<script>"';
    expect(parseKnowledgeCsvPreview(content).rows).toEqual([
      ["sku", "amount", "note"],
      ["001", "0007", "line one, line two"],
      ["002", "=SUM(A1:A2)", "<script>"],
    ]);
    const markup = renderToStaticMarkup(<KnowledgeCsvPreview content={content} />);
    expect(markup).toContain("values shown as text");
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).toContain("does not infer number types or execute spreadsheet formulas");
  });

  it("bounds preview dimensions and reports malformed quoted input", () => {
    const manyColumns = Array.from({ length: 45 }, (_, index) => `c${index}`).join(",");
    const manyRows = Array.from({ length: 205 }, (_, index) => `${index},value`).join("\n");
    const result = parseKnowledgeCsvPreview(`${manyColumns}\n${manyRows}\n\"unfinished`);
    expect(result.rows.length).toBeLessThanOrEqual(201);
    expect(result.rows[0]?.length).toBe(40);
    expect(result.truncatedRows).toBe(true);
    expect(result.truncatedColumns).toBe(true);
    expect(result.malformedQuotes).toBe(true);
  });

  it("clips oversized cell display values without changing the submitted source", () => {
    const source = `name\n${"x".repeat(300)}`;
    const result = parseKnowledgeCsvPreview(source);
    expect(result.rows[1]?.[0]).toHaveLength(256);
    expect(result.truncatedCells).toBe(true);
    expect(source).toHaveLength(305);
  });
});
