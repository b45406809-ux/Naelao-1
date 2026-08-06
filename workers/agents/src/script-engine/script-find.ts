/**
 * script.find — semantic + fingerprint search across the skill library (spec §16
 * "Embedding for script.find").
 *
 * Implementation (spec exact):
 *   1. Embed the natural-language query.
 *   2. ANN search against all script embedding vectors (Vectorize, top-K = 10).
 *   3. Filter results by fingerprint_schema compatibility with current environment state.
 *   4. Filter by domain if specified.
 *   5. Sort by stability_score × semantic_similarity.
 *   6. Return top 3 candidates with confidence scores.
 *
 * Confidence < 0.5 for the top candidate ⇒ treat as "no match" ⇒ escalate to Level 4.
 *
 * Degradation: when no Vectorize index/embedder is wired (e.g. dev), fall back to a
 * tag/substring scan over the library so the engine still functions.
 */

import type {
  ScriptEngineEnv,
  FindCandidate,
  ObserveSnapshot,
  ScriptDomain,
  ScriptMetadata,
} from "./types.js";
import { SkillLibrary } from "./skill-library.js";
import { fingerprintSimilarity } from "./fingerprint.js";
import { assessSkillHealth, healthConfidenceMultiplier } from "./skill-health.js";

export const FIND_CONFIDENCE_FLOOR = 0.5;

function vectorId(spaceId: string, name: string): string {
  return `${spaceId}::${name}`;
}

/** Index a script's embedding so script.find can retrieve it. Called at create/update. */
export async function indexScriptEmbedding(
  env: ScriptEngineEnv,
  metadata: ScriptMetadata
): Promise<void> {
  if (!env.vectorIndex || !env.embedder) return;
  const text = `${metadata.description}\n\ntags: ${metadata.tags.join(", ")}\ndomain: ${metadata.domain}`;
  const vector = await env.embedder.embed(text);
  await env.vectorIndex.upsert([
    {
      id: vectorId(env.spaceId, metadata.name),
      values: vector,
      // Vectorize filter syntax is flat — {field: {$eq: value}} (see CLAUDE.md invariants).
      metadata: { spaceId: env.spaceId, name: metadata.name, domain: metadata.domain },
    },
  ]);
}

export async function removeScriptEmbedding(env: ScriptEngineEnv, name: string): Promise<void> {
  if (!env.vectorIndex) return;
  await env.vectorIndex.deleteByIds([vectorId(env.spaceId, name)]);
}

export async function scriptFind(
  env: ScriptEngineEnv,
  query: string,
  opts: { snapshot?: ObserveSnapshot; domain?: ScriptDomain; limit?: number } = {}
): Promise<FindCandidate[]> {
  const library = new SkillLibrary(env.scriptsBucket, env.spaceId);
  const limit = opts.limit ?? 3;

  let ranked: FindCandidate[];

  if (env.vectorIndex && env.embedder) {
    // Steps 1-2: embed + ANN search (top-K 10), scoped to this space.
    const queryVec = await env.embedder.embed(query);
    const filter: Record<string, unknown> = { spaceId: { $eq: env.spaceId } };
    if (opts.domain) filter["domain"] = { $eq: opts.domain };
    const res = await env.vectorIndex.query(queryVec, { topK: 10, filter, returnMetadata: true });

    const candidates = await Promise.all(
      res.matches.map(async (match) => {
        const name = (match.metadata?.["name"] as string) ?? "";
        if (!name) return null;
        const metadata = await library.readMetadata(name);
        if (!metadata) return null;
        return { name, metadata, semantic_similarity: match.score } as const;
      })
    );
    ranked = candidates.filter((c): c is NonNullable<typeof c> => c !== null).map((c) => ({
      name: c.name,
      metadata: c.metadata,
      semantic_similarity: c.semantic_similarity,
      relevance: 0,
      confidence: 0,
    }));
  } else {
    // Degraded path: tag/substring scan, semantic_similarity approximated by token overlap.
    const names = await library.list();
    const q = query.toLowerCase();
    const qTokens = new Set(q.split(/\s+/).filter(Boolean));
    const scored: FindCandidate[] = [];
    for (const name of names) {
      const metadata = await library.readMetadata(name);
      if (!metadata) continue;
      if (opts.domain && metadata.domain !== opts.domain) continue;
      const hay = `${name} ${metadata.description} ${metadata.tags.join(" ")}`.toLowerCase();
      const hayTokens = new Set(hay.split(/\s+/).filter(Boolean));
      const overlap = [...qTokens].filter((t) => hayTokens.has(t)).length;
      const sim = qTokens.size === 0 ? 0 : overlap / qTokens.size;
      if (sim > 0 || hay.includes(q)) {
        scored.push({
          name,
          metadata,
          semantic_similarity: Math.max(sim, hay.includes(q) ? 0.6 : 0),
          relevance: 0,
          confidence: 0,
        });
      }
    }
    ranked = scored;
  }

  // Steps 3-4: fingerprint compatibility + domain filter (domain already applied above).
  for (const c of ranked) {
    if (opts.snapshot) {
      const fpSim = fingerprintSimilarity(opts.snapshot, c.metadata.fingerprint_schema);
      // Fold fingerprint compatibility into confidence so incompatible scripts rank lower.
      c.semantic_similarity = c.semantic_similarity * (0.5 + 0.5 * fpSim);
    }
    // Step 5: sort key, in two parts that answer two different questions.
    //
    // `relevance` is the original one — is this skill about the right thing. `stability_score`
    // is a LIFETIME ratio, so it cannot express recency: 20 successes and 4 failures scores the
    // same whether those failures are spread over a year or are the last four in a row. Health
    // (skill-health.ts) is that missing layer, and it only ever affects `confidence` — the
    // ranking — never relevance. A broken skill is demoted hard so anything that works wins,
    // but it stays fully relevant and fully findable, because an agent cannot repair a skill it
    // can't see, and its own recorded error is the best input to that repair.
    c.health = assessSkillHealth(c.metadata);
    c.relevance = c.metadata.stability_score * c.semantic_similarity;
    c.confidence = c.relevance * healthConfidenceMultiplier(c.health.state);
  }

  ranked.sort((a, b) => b.confidence - a.confidence);
  return ranked.slice(0, limit);
}
