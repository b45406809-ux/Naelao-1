import { describe, expect, it } from "vitest";
import { PREBUILT_SCRIPTS } from "./index.js";
import {
  detectLanguageCandidates,
  languageDetection,
} from "./language-detection.js";

describe("offline language candidate detection", () => {
  it("returns bounded candidates without confidence claims or provider access", () => {
    const result = detectLanguageCandidates({
      text: "Bonjour, je voudrais comprendre comment fonctionne cette application et obtenir de l'aide.",
    });
    expect(result.status).toBe("candidates");
    expect(result.candidates[0]).toEqual({
      iso_639_3: "fra",
      translation_language: "fr",
    });
    expect(result.candidates.length).toBeLessThanOrEqual(3);
    expect(result).not.toHaveProperty("confidence");
    expect(result).not.toHaveProperty("score");
    expect(result.notice).toContain("not calibrated");
    expect(languageDetection.operations["language.detect"]).toBeTypeOf(
      "function"
    );
    expect(PREBUILT_SCRIPTS["language-detection"]).toBe(languageDetection);
  });

  it("rejects short, empty, non-text, and oversized samples", () => {
    for (const text of ["Hi", " ", 42, "x".repeat(8_001)]) {
      expect(() => detectLanguageCandidates({ text })).toThrow(
        "language.detect requires text"
      );
    }
  });
});
