import { describe, expect, it } from "vitest";
import { citationsFromTrace } from "./NaelaoAgentDO.js";

describe("citationsFromTrace", () => {
  it("extracts verified knowledge coordinates with stable deduplicated ordinals", () => {
    const result = citationsFromTrace([
      {
        seq: 1, phase: "run", name: "knowledge.search", ok: true,
        output: JSON.stringify({ data: [{ citation: { document_id: "doc-1", chunk_id: "doc-1_chunk_0", title: "Policy" } }] }),
      },
      {
        seq: 2, phase: "run", name: "knowledge.search", ok: true,
        output: JSON.stringify({ citations: [{ document_id: "doc-1", chunk_id: "doc-1_chunk_0" }, { document_id: "doc-2", chunk_id: "doc-2_chunk_1" }] }),
      },
      { seq: 3, phase: "run", name: "knowledge.search", ok: false, output: JSON.stringify({ citations: [{ document_id: "ignored", chunk_id: "ignored" }] }) },
    ]);
    expect(result).toEqual([
      { version: 1, ordinal: 1, identity: "doc-1:doc-1_chunk_0", document_id: "doc-1", chunk_id: "doc-1_chunk_0", label: "Policy" },
      { version: 1, ordinal: 2, identity: "doc-2:doc-2_chunk_1", document_id: "doc-2", chunk_id: "doc-2_chunk_1" },
    ]);
  });

  it("ignores malformed or non-knowledge trace output", () => {
    expect(citationsFromTrace([
      { seq: 1, phase: "run", name: "web-search.search", ok: true, output: JSON.stringify({ citations: [{ document_id: "x", chunk_id: "y" }] }) },
      { seq: 2, phase: "run", name: "knowledge.search", ok: true, output: "truncated" },
    ])).toEqual([]);
  });
});
