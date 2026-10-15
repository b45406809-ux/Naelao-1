import type { PrebuiltOpContext, PrebuiltScript } from "./index.js";

const MODEL = "@cf/meta/m2m100-1.2b";
const MAX_TEXT_CHARS = 8_000;
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  ar: "arabic", de: "german", en: "english", es: "spanish", fr: "french",
  hi: "hindi", it: "italian", ja: "japanese", ko: "korean", pt: "portuguese",
  sw: "swahili", zh: "chinese",
};

export interface TranslationRequest { text: string; sourceLanguage: string; targetLanguage: string }
export interface TranslationResult {
  source_text: string;
  translated_text: string;
  source_language: string;
  target_language: string;
  provider: "cloudflare-workers-ai";
  model: typeof MODEL;
  verification: "machine_translation_unverified";
}

function language(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length < 2 || value.trim().length > 32) {
    throw new Error(`language.translate requires ${field} as a supported language code`);
  }
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(normalized)) throw new Error(`language.translate ${field} must be a BCP-47 language code`);
  const base = normalized.split("-")[0]!;
  const modelLanguage = LANGUAGE_ALIASES[base];
  if (!modelLanguage) throw new Error(`language.translate ${field} is outside the currently enabled language subset`);
  return modelLanguage;
}

function translatedText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const row = value as Record<string, unknown>;
  for (const key of ["translated_text", "translation", "response", "text"]) {
    if (typeof row[key] === "string") return (row[key] as string).trim();
  }
  return "";
}

export async function translateText(args: Record<string, unknown>, ctx: PrebuiltOpContext): Promise<TranslationResult> {
  const source = args["text"];
  if (typeof source !== "string" || !source.trim() || source.length > MAX_TEXT_CHARS) {
    throw new Error(`language.translate requires non-empty text up to ${MAX_TEXT_CHARS} characters`);
  }
  const sourceLanguage = language(args["source_language"], "source_language");
  const targetLanguage = language(args["target_language"], "target_language");
  if (sourceLanguage === targetLanguage) throw new Error("language.translate source and target languages must differ");
  if (ctx.env.airGappedOnly) throw new Error("private_translation_cloud_model_denied");
  if (!ctx.env.translateText) throw new Error("language_translation_unavailable");
  const output = translatedText(await ctx.env.translateText({ text: source, sourceLanguage, targetLanguage }));
  if (!output || output.length > MAX_TEXT_CHARS * 4) throw new Error("language_translation_response_invalid");
  return {
    source_text: source,
    translated_text: output,
    source_language: sourceLanguage,
    target_language: targetLanguage,
    provider: "cloudflare-workers-ai",
    model: MODEL,
    verification: "machine_translation_unverified",
  };
}

export const languageTranslation: PrebuiltScript = {
  name: "language-translation",
  description: "Create a bounded machine translation with the original preserved. It is a draft and must be checked before consequential use.",
  domain: "knowledge",
  requires_tier: 1,
  operations: { "language.translate": translateText },
  paramHints: {
    "language.translate": "text: up to 8000 characters; source_language and target_language: currently enabled tags ar, de, en, es, fr, hi, it, ja, ko, pt, sw, zh. Returns original and machine translation; it is not quality-verified and must not be used as authorization or sent externally without review.",
  },
};

export const languageTranslationForTest = { model: MODEL, language };
