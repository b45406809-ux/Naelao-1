import type { BlueprintSetupField } from "@naelao/agent-sdk";

type LocalizedText = Record<string, string>;
type LocalizedOptions = Record<string, Record<string, string>>;

function localeCandidates(locale: string): string[] {
  const normalized = locale.trim().replaceAll("_", "-").toLowerCase();
  if (!normalized) return [];
  return [...new Set([normalized, normalized.split("-")[0] ?? ""])].filter(Boolean);
}

function byLocale<T>(values: Record<string, T> | undefined, locale: string): T | undefined {
  if (!values) return undefined;
  const entries = Object.entries(values);
  for (const candidate of localeCandidates(locale)) {
    const match = entries.find(([key]) => key.trim().replaceAll("_", "-").toLowerCase() === candidate);
    if (match) return match[1];
  }
  return undefined;
}

export function localizedExtensionFieldLabel(field: BlueprintSetupField, locale: string): string {
  const localization = "localization" in field ? field.localization : undefined;
  return byLocale(localization?.label, locale) ?? field.label;
}

export function localizedExtensionFieldHelp(field: BlueprintSetupField, locale: string): string | undefined {
  const localization = "localization" in field ? field.localization : undefined;
  return byLocale(localization?.helpText, locale) ?? field.helpText;
}

export function localizedExtensionOptionLabel(field: BlueprintSetupField, optionValue: string, locale: string, fallback: string): string {
  const localization = "localization" in field ? field.localization : undefined;
  const options = localization?.optionLabels as LocalizedOptions | undefined;
  const entries = Object.entries(options ?? {});
  for (const candidate of localeCandidates(locale)) {
    const match = entries.find(([key]) => key.trim().replaceAll("_", "-").toLowerCase() === candidate)?.[1]?.[optionValue];
    if (match !== undefined) return match;
  }
  return fallback;
}
