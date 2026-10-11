/**
 * Deterministic relevance gate for structured project facts.
 *
 * Facts are durable cross-thread truth, so a high trust score alone must not make
 * an unrelated fact visible to a new thread. We score coverage of meaningful query
 * terms and keep the threshold at the same 0.80 boundary used by semantic memory.
 */
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "be", "by", "for", "from", "how", "i", "in", "is",
  "it", "of", "on", "or", "that", "the", "this", "to", "was", "what", "when", "where",
  "which", "who", "why", "with", "you",
]);

export function meaningfulFactTokens(value: string): string[] {
  return [...new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2 && !STOP_WORDS.has(token))
  )];
}

export function projectFactRelevance(query: string, fact: string): number {
  const queryTokens = meaningfulFactTokens(query);
  if (queryTokens.length === 0) return 0;
  const normalizedFact = fact.toLowerCase();
  const normalizedQuery = query.toLowerCase().trim();
  if (normalizedQuery.length > 2 && normalizedFact.includes(normalizedQuery)) return 1;
  const factTokens = new Set(meaningfulFactTokens(fact));
  const matched = queryTokens.reduce((count, token) => count + (factTokens.has(token) ? 1 : 0), 0);
  return matched / queryTokens.length;
}
