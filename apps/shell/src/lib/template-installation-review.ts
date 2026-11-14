/** Only opaque project identifiers safe as a single route segment may become owner links. */
export function safeTemplateProjectIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id)))].slice(0, 256);
}
