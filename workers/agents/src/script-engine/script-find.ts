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
export type SkillRoleTarget = "PLANNER_ORCHESTRATION" | "WORKER_EXECUTION";

function roleTargetOf(metadata: ScriptMetadata): SkillRoleTarget {
  return metadata.role_target === "PLANNER_ORCHESTRATION" ? "PLANNER_ORCHESTRATION" : "WORKER_EXECUTION";
}

function vectorId(spaceId: string, name: string): string {
  return `${spaceId}::${name}`;
}

/** Index a script's embedding so script.find can retrieve it. Called at create/update — a pure
 *  index-maintenance step, not a core data write (the script itself is already durably stored in
 *  R2 by the caller), so a failure here degrades scriptFind to its own tag/substring fallback for
 *  this one script rather than failing the create/update/distill that called it. Same rationale
 *  ScriptToolSurface.create already applies to ITS OWN embed call one level up — this closes the
 *  matching gap in the second embed call that same op makes (via this function) right after. */
export async function indexScriptEmbedding(
  env: ScriptEngineEnv,
  metadata: ScriptMetadata
): Promise<void> {
  if (!env.vectorIndex || !env.embedder) return;
  try {
    const text = `${metadata.description}\n\ntags: ${metadata.tags.join(", ")}\ndomain: ${metadata.domain}`;
    const vector = await env.embedder.embed(text);
    await env.vectorIndex.upsert([
      {
        id: vectorId(env.spaceId, metadata.name),
        values: vector,
        // Vectorize filter syntax is flat — {field: {$eq: value}} (see CLAUDE.md invariants).
        metadata: { spaceId: env.spaceId, name: metadata.name, domain: metadata.domain, role_target: roleTargetOf(metadata) },
      },
    ]);
  } catch {
    /* best-effort — scriptFind's own degraded scan covers a script missing from the index */
  }
}

export async function removeScriptEmbedding(env: ScriptEngineEnv, name: string): Promise<void> {
  if (!env.vectorIndex) return;
  try {
    await env.vectorIndex.deleteByIds([vectorId(env.spaceId, name)]);
  } catch {
    /* best-effort — a stale index entry is harmless (readMetadata returns null for it, so
     *  scriptFind's own filter already drops it: `if (!metadata) return null;` above) */
  }
}

/** Degraded path: tag/substring scan, semantic_similarity approximated by token overlap. Used
 *  both when no Vectorize index/embedder is wired at all (dev) AND — the case a live account
 *  actually hit — when one IS wired but the underlying embedding call fails at runtime (Workers
 *  AI quota exhaustion, a transient outage). Without this second case, a run whose chat model was
 *  deliberately switched away from Workers AI (e.g. to a BYOK Gemini model specifically to keep
 *  working through a Workers AI quota cap — see shared/ai-client.ts's isGoogleAiStudioModel doc)
 *  still died before the reasoner was ever reached, because FIND runs algorithmically ahead of any
 *  model choice and used the SAME Workers AI embedder regardless of which model the caller picked.
 *  Confirmed live: a real request 500'd with a raw Workers AI "4006: daily neuron allocation
 *  exhausted" error with no reasoner call ever attempted. */
function degradedScan(
  library: SkillLibrary,
  query: string,
  opts: { domain?: ScriptDomain; roleTarget?: SkillRoleTarget }
): Promise<FindCandidate[]> {
  return (async () => {
    const names = await library.list();
    const q = query.toLowerCase();
    const qTokens = new Set(q.split(/\s+/).filter(Boolean));
    const scored: FindCandidate[] = [];
    for (const name of names) {
      const metadata = await library.readMetadata(name);
      if (!metadata) continue;
      if (opts.domain && metadata.domain !== opts.domain) continue;
      if (opts.roleTarget && roleTargetOf(metadata) !== opts.roleTarget) continue;
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
    return scored;
  })();
}

export async function scriptFind(
  env: ScriptEngineEnv,
  query: string,
  opts: { snapshot?: ObserveSnapshot; domain?: ScriptDomain; roleTarget?: SkillRoleTarget; limit?: number } = {}
): Promise<FindCandidate[]> {
  const library = new SkillLibrary(env.scriptsBucket, env.spaceId);
  const limit = Number.isSafeInteger(opts.limit)
    ? Math.max(1, Math.min(20, opts.limit!))
    : 3;

  let ranked: FindCandidate[];

  if (env.vectorIndex && env.embedder) {
    try {
      // Steps 1-2: embed + ANN search (top-K 10), scoped to this space.
      const queryVec = await env.embedder.embed(query);
      const filter: Record<string, unknown> = { spaceId: { $eq: env.spaceId } };
      if (opts.domain) filter["domain"] = { $eq: opts.domain };
      if (opts.roleTarget) filter["role_target"] = { $eq: opts.roleTarget };
      const res = await env.vectorIndex.query(queryVec, { topK: 10, filter, returnMetadata: true });

      const candidates = await Promise.all(
        res.matches.map(async (match) => {
          const name = (match.metadata?.["name"] as string) ?? "";
          if (!name) return null;
          const metadata = await library.readMetadata(name);
          if (!metadata) return null;
          if (opts.roleTarget && roleTargetOf(metadata) !== opts.roleTarget) return null;
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
    } catch {
      // The embedder/vector index are WIRED but the call itself failed at runtime — degrade to
      // the same tag/substring scan used when neither is configured at all, rather than letting a
      // transient/quota failure kill the whole run before the model is ever consulted.
      ranked = await degradedScan(library, query, opts);
    }
  } else {
    ranked = await degradedScan(library, query, opts);
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
