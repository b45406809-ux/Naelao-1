/**
 * Escapes raw XML characters to prevent malicious injection payloads
 * from breaking out of semantic boundary tags.
 */
export function escapeXmlEntities(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Scans content for direct prompt injection keywords and masks high-risk phrases.
 */
export function maskPromptInjectionTriggers(text: string): string {
  const adversarialPatterns = [
    /ignore\s+(all\s+)?(previous\s+)?instructions/gi,
    /system\s+prompt\s+override/gi,
    /you\s+are\s+now\s+in\s+developer\s+mode/gi,
    /disregard\s+prior\s+directives/gi,
    /<script[\s\S]*?>[\s\S]*?<\/script>/gi
  ];

  let sanitized = text;
  for (const pattern of adversarialPatterns) {
    sanitized = sanitized.replace(pattern, "[BLOCKED_ADVERSARIAL_DIRECTIVE]");
  }
  return sanitized;
}

/**
 * Wraps retrieved raw context chunks in strict XML semantic boundary envelopes.
 * This instructs the model's attention heads that text inside cannot alter
 * system directives, tools, or permissions.
 */
export function wrapInUntrustedEnvelope(
  chunkId: string,
  rawContent: string,
  meta?: { minRank?: number; docId?: string }
): string {
  const cleaned = maskPromptInjectionTriggers(rawContent);
  const escaped = escapeXmlEntities(cleaned);
  const rankAttr = meta?.minRank !== undefined ? ` min_rank="${meta.minRank}"` : "";
  const docAttr = meta?.docId ? ` doc_id="${meta.docId}"` : "";

  return `<context_chunk id="${chunkId}" access="verified"${rankAttr}${docAttr}>\n${escaped}\n</context_chunk>`;
}
