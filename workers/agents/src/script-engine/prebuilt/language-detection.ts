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
const LANGUAGE_TAG_TO_ISO: Readonly<Record<string, string>> = {
  ar: "arb", de: "deu", en: "eng", es: "spa", fr: "fra", hi: "hin",
  it: "ita", ja: "jpn", ko: "kor", pt: "por", sw: "swh", zh: "cmn",
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
  preferred_candidates?: LanguageCandidate[];
  preferred_languages_applied?: string[];
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

  // Preferences are an additional hypothesis list, never a whitelist gate: always preserve
  // unrestricted candidates so code-switched, unexpected, and low-resource input is not hidden.
  const preferred = args.preferred_languages;
  let preferredResult: Pick<ReturnType<typeof detectLanguageCandidates>, "preferred_candidates" | "preferred_languages_applied"> = {};
  if (preferred !== undefined) {
    if (!Array.isArray(preferred) || preferred.length > 32 || preferred.some(value =>
      typeof value !== "string" || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}$/i.test(value.trim())
    )) throw new Error("language.detect preferred_languages must be up to 32 BCP-47 tags");
    const normalized = [...new Set((preferred as string[]).map(value => value.trim().toLowerCase()))];
    const allowedIso = [...new Set(normalized.map(tag => LANGUAGE_TAG_TO_ISO[tag.split("-")[0]!]).filter((value): value is string => Boolean(value)))];
    const preferredRanked = allowedIso.length ? francAll(text.trim(), { minLength: MIN_TEXT_CHARS, only: allowedIso }).slice(0, 3) : [];
    preferredResult = {
      preferred_languages_applied: normalized,
      preferred_candidates: preferredRanked.filter(([code]) => code !== "und").map(([code]) => ({
        iso_639_3: code,
        translation_language: TRANSLATION_LANGUAGE[code] ?? null,
      })),
    };
  }

  return {
    candidates,
    ...preferredResult,
    status: candidates.length ? "candidates" : "undetermined",
    method: "offline_trigram_ranker",
    notice:
      "Candidates are not calibrated confidence or verified language labels. preferred_candidates are extra hypotheses from the supplied preference list; unrestricted candidates are always retained. Mixed, short, named-entity-heavy, or unsupported text can be ambiguous. Do not set a language preference or translate consequential content from this result alone; ask the user when the language matters.",
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
      "text: 40–8000 characters; optional preferred_languages: up to 32 BCP-47 tags from the FDE template. Returns unrestricted candidates and a separate preference-filtered list; preferences never block unexpected or code-switched input and do not imply confidence.",
  },
};
