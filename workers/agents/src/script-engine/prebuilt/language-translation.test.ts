import { describe, expect, it, vi } from "vitest";
import { languageTranslation, languageTranslationForTest, translateText } from "./language-translation.js";

describe("Workers AI language translation", () => {
  it("uses the documented model contract and preserves source and provenance", async () => {
    const translate = vi.fn(async (input: { text: string; sourceLanguage: string; targetLanguage: string }) => {
      expect(input).toEqual({ text: "Good morning", sourceLanguage: "english", targetLanguage: "swahili" });
      return { translated_text: "Habari za asubuhi" };
    });
    const result = await translateText({ text: "Good morning", source_language: "en", target_language: "sw" }, {
      env: { scriptsBucket: {} as never, translateText: translate }, run: vi.fn(),
    });
    expect(result).toMatchObject({
      source_text: "Good morning", translated_text: "Habari za asubuhi", source_language: "english",
      target_language: "swahili", provider: "cloudflare-workers-ai", model: "@cf/meta/m2m100-1.2b",
      verification: "machine_translation_unverified",
    });
  });

  it("fails closed for private Spaces, unsupported languages, malformed results and oversized input", async () => {
    const run = vi.fn();
    const args = { text: "hello", source_language: "en", target_language: "fr" };
    await expect(translateText(args, { env: { scriptsBucket: {} as never, airGappedOnly: true, translateText: run }, run })).rejects.toThrow("private_translation_cloud_model_denied");
    await expect(translateText({ ...args, target_language: "xx" }, { env: { scriptsBucket: {} as never, translateText: run }, run })).rejects.toThrow("outside the currently enabled language subset");
    await expect(translateText(args, { env: { scriptsBucket: {} as never, translateText: async () => ({ unexpected: "shape" }) }, run })).rejects.toThrow("language_translation_response_invalid");
    await expect(translateText({ ...args, text: "x".repeat(8_001) }, { env: { scriptsBucket: {} as never, translateText: run }, run })).rejects.toThrow("up to 8000 characters");
    expect(run).not.toHaveBeenCalled();
  });

  it("is discoverable as a tier-one, non-sending prebuilt", () => {
    expect(languageTranslation).toMatchObject({ requires_tier: 1, operations: { "language.translate": expect.any(Function) } });
    expect(languageTranslationForTest.model).toBe("@cf/meta/m2m100-1.2b");
  });
});
