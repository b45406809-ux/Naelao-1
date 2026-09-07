export interface DistilledRuleMetadata {
  ruleId: string;
  ruleText: string;
  scope: "BOT_SKILL" | "PROJECT_SHARED" | "USER_PRIVATE";
  botId: string;
  spaceId: string;
  projectId?: string;
  derivedFromTaskId?: string;
  createdAt: string;
}

export interface GatedFactMatch {
  rule: DistilledRuleMetadata;
  similarity: number;
}

/**
 * Calculates cosine similarity between two normalized vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Filters candidate vector matches against a strict relevance floor.
 * Discards low-similarity chunks to prevent context pollution.
 */
export function filterFactsByRelevance(
  candidateMatches: Array<{ id: string; score: number; metadata: any }>,
  similarityThreshold: number = 0.80
): GatedFactMatch[] {
  return candidateMatches
    .filter(match => match.score >= similarityThreshold)
    .map(match => ({
      rule: {
        ruleId: match.id,
        ruleText: match.metadata?.rule_text || "",
        scope: match.metadata?.scope || "BOT_SKILL",
        botId: match.metadata?.bot_id || "",
        spaceId: match.metadata?.space_id || "",
        projectId: match.metadata?.project_id,
        derivedFromTaskId: match.metadata?.derived_from_task_id,
        createdAt: match.metadata?.created_at || new Date().toISOString()
      },
      similarity: match.score
    }))
    .sort((a, b) => b.similarity - a.similarity);
}

/**
 * Formats gated facts into a clean XML block for prompt insertion.
 */
export function formatGatedFactsForPrompt(facts: GatedFactMatch[]): string {
  if (facts.length === 0) return "";

  const items = facts.map(f => 
    `  <learned_rule id="${f.rule.ruleId}" confidence="${f.similarity.toFixed(2)}">\n    ${f.rule.ruleText}\n  </learned_rule>`
  ).join("\n");

  return `<recalled_rules count="${facts.length}">\n${items}\n</recalled_rules>`;
}
