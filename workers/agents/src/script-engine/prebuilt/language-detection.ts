import { francAll } from "franc-min";
import type { PrebuiltScript } from "./index.js";

const MAX_TEXT_CHARS = 8_000;
const MIN_TEXT_CHARS = 40;
const TRANSLATION_LANGUAGE: Readonly<Record<string, string>> = {
  arb: "ar",
  deu: "de",
  eng: "en",
  spa: "es",
  fra: "fr",
  hin: "hi",
  ita: "it",
  jpn: "ja",
  kor: "ko",
  por: "pt",
  swh: "sw",
  cmn: "zh",
};

export interface LanguageCandidate {
  iso_639_3: string;
  translation_language: string | null;
}

/**
 * Return offline trigram candidates only. The model's ranking is not calibrated as confidence,
 * so callers must preserve ambiguity and must not treat this as a preference or verified fact.
 */
export function detectLanguageCandidates(args: Record<string, unknown>): {
  candidates: LanguageCandidate[];
  status: "candidates" | "undetermined";
  method: "offline_trigram_ranker";
  notice: string;
} {
  const text = args.text;
  if (
    typeof text !== "string" ||
    text.trim().length < MIN_TEXT_CHARS ||
    text.length > MAX_TEXT_CHARS
  ) {
    throw new Error(
      `language.detect requires text between ${MIN_TEXT_CHARS} and ${MAX_TEXT_CHARS} characters`
    );
  }

  const ranked = francAll(text.trim(), { minLength: MIN_TEXT_CHARS }).slice(
    0,
    3
  );
  const candidates = ranked
    .filter(([code]) => code !== "und")
    .map(([code]) => ({
      iso_639_3: code,
      translation_language: TRANSLATION_LANGUAGE[code] ?? null,
    }));

  return {
    candidates,
    status: candidates.length ? "candidates" : "undetermined",
    method: "offline_trigram_ranker",
    notice:
      "Candidates are not calibrated confidence or verified language labels. Mixed, short, named-entity-heavy, or unsupported text can be ambiguous. Do not set a language preference or translate consequential content from this result alone; ask the user when the language matters.",
  };
}

export const languageDetection: PrebuiltScript = {
  name: "language-detection",
  description:
    "Suggest offline language candidates for sufficiently long text without sending it to a provider. Results are not verified and do not set user preferences.",
  domain: "knowledge",
  requires_tier: 1,
  operations: {
    "language.detect": async (args) => detectLanguageCandidates(args),
  },
  paramHints: {
    "language.detect":
      "text: 40–8000 characters. Returns up to three ISO 639-3 candidates and whether the existing translator supports each; does not infer confidence or change preferences.",
  },
};
