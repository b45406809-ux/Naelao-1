import { describe, expect, it } from "vitest";
import { matchGlossaryTerms, normalizeGlossaryTerm, validateGlossaryEntry } from "./domain-glossary.js";

describe("Space domain glossary", () => {
  it("normalizes Unicode and whitespace but keeps lookup exact", () => {
    expect(normalizeGlossaryTerm("  Cafe\u0301   X ")).toBe("café x");
    expect(matchGlossaryTerms([
      { term: "moyo", meaning: "community health worker", locale: "sn" },
      { term: "moyo wathu", meaning: "our community", locale: "sn" },
    ], [" MOYO "])).toEqual([{ term: "moyo", meaning: "community health worker", locale: "sn" }]);
  });

  it("validates bounded owner-authored entries and filters by locale", () => {
    expect(validateGlossaryEntry({ term: " Moyo ", meaning: "Community health worker", locale: "sn" })).toEqual({
      entry: { term: "Moyo", meaning: "Community health worker", locale: "sn" },
    });
    expect(validateGlossaryEntry({ term: "", meaning: "meaning" })).toMatchObject({ error: "glossary_entry_invalid" });
    expect(matchGlossaryTerms([
      { term: "moyo", meaning: "general", locale: "und" },
      { term: "moyo", meaning: "specific", locale: "sn" },
    ], ["moyo"], "sn")).toHaveLength(2);
    expect(matchGlossaryTerms([{ term: "moyo", meaning: "specific", locale: "sn" }], ["moyo"], "en")).toEqual([]);
  });
});
