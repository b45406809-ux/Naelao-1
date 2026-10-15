export interface DomainGlossaryEntry {
  term: string;
  meaning: string;
  locale: string;
  notes?: string;
}

export function normalizeGlossaryTerm(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("und");
}

export function validateGlossaryEntry(input: unknown): { entry?: DomainGlossaryEntry; error?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "glossary_entry_invalid" };
  const value = input as Record<string, unknown>;
  const term = typeof value.term === "string" ? value.term.normalize("NFKC").trim().replace(/\s+/gu, " ") : "";
  const meaning = typeof value.meaning === "string" ? value.meaning.normalize("NFKC").trim() : "";
  const locale = typeof value.locale === "string" ? value.locale.trim().toLowerCase() : "und";
  const notes = typeof value.notes === "string" ? value.notes.trim() : "";
  if (!term || term.length > 160 || !meaning || meaning.length > 1000 || !/^(und|[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3})$/i.test(locale) || notes.length > 500) {
    return { error: "glossary_entry_invalid" };
  }
  return { entry: { term, meaning, locale, ...(notes ? { notes } : {}) } };
}

/** Exact phrase lookup only. Glossary text is owner-authored context, never executable authority. */
export function matchGlossaryTerms(entries: readonly DomainGlossaryEntry[], terms: readonly string[], locale?: string): DomainGlossaryEntry[] {
  const wanted = new Set(terms.map(normalizeGlossaryTerm).filter(Boolean));
  const preferredLocale = locale?.trim().toLowerCase();
  const matches = new Map<string, DomainGlossaryEntry>();
  for (const entry of entries) {
    if (preferredLocale && entry.locale !== "und" && entry.locale.toLowerCase() !== preferredLocale) continue;
    const key = normalizeGlossaryTerm(entry.term);
    if (wanted.has(key) && !matches.has(`${entry.locale}:${key}`)) matches.set(`${entry.locale}:${key}`, entry);
  }
  return [...matches.values()].slice(0, 20);
}
