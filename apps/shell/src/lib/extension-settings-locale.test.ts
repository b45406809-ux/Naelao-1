import { describe, expect, it } from "vitest";
import { localizedExtensionFieldHelp, localizedExtensionFieldLabel, localizedExtensionOptionLabel } from "./extension-settings-locale.js";

describe("localized extension setup fields", () => {
  const field = {
    id: "language", type: "select" as const, label: "Language", helpText: "Choose the reply language.",
    options: [{ value: "en", label: "English" }, { value: "fr", label: "French" }],
    localization: {
      label: { fr: "Langue", "fr-CA": "Langue préférée" },
      helpText: { fr: "Choisissez la langue de réponse." },
      optionLabels: { fr: { en: "Anglais", fr: "Français" }, "fr-CA": { en: "Anglais (Canada)" } },
    },
  };

  it("prefers an exact browser locale and falls back to its base language", () => {
    expect(localizedExtensionFieldLabel(field, "fr-CA")).toBe("Langue préférée");
    expect(localizedExtensionFieldHelp(field, "fr-CA")).toBe("Choisissez la langue de réponse.");
    expect(localizedExtensionOptionLabel(field, "en", "fr-CA", "English")).toBe("Anglais (Canada)");
    expect(localizedExtensionOptionLabel(field, "fr", "fr-CA", "French")).toBe("Français");
  });

  it("uses the signed schema text when the browser language has no translation", () => {
    expect(localizedExtensionFieldLabel(field, "es-MX")).toBe("Language");
    expect(localizedExtensionFieldHelp(field, "es")).toBe("Choose the reply language.");
    expect(localizedExtensionOptionLabel(field, "en", "es", "English")).toBe("English");
  });
});
