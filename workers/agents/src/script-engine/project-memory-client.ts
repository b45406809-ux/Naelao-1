/**
 * §A1.17 Phase U — Memory OS project-shared layers.
 *
 * T2 committed each (thread, agentId) pair to its OWN NaelaoAgentDO instance/memory — without
 * this module, two threads in the SAME project (or two different @mentioned agents in the same
 * project) would have ZERO shared knowledge, since Layers 3 (facts)/4 (fabric)/6 (wiki) live in
 * each DO's own SQLite (memory-os.ts). This module provides two pieces:
 *
 *   - `buildProjectMemoryStore(opts)` — a MemoryStore backed by HTTP calls to SpaceDO's new
 *     project-scoped memory routes (workers/spaces/src/do/SpaceDO.ts). Its `remember`/`recall`/
 *     `forget` only ever handle STRUCTURED FACTS (entity/relation/attribute) — this store has no
 *     episodic/semantic concept at all, matching what SpaceDO's project_facts table stores.
 *   - `buildHybridMemoryStore(local, project)` — composes a local (per-agent, Layer 5-capable)
 *     store with a project-scoped one: fact remember/recall routes to the project store,
 *     free-text episodic remember stays local, recall merges both, and Fabric/Wiki (Layer 4/6)
 *     ALWAYS go to the project store. Used whenever a run is project-bound; the Space Assistant's
 *     own `_assistant` slot (no projectId) keeps using the local store directly, unwrapped —
 *     NaelaoAgentDO only reaches for this module when projectId is present.
 */

import type { MemoryStore, MemoryRecallResult, FabricEntry, WikiArticle } from "./types.js";
import { gateMemory } from "./memory/gate-memory.js";
import { projectFactRelevance, type FastDecisionGateway } from "@naelao/agent-sdk";

export interface ProjectMemoryClientOptions {
  spacesWorker: Fetcher;
  platformSecret: string;
  spaceId: string;
  tenantId: string;
  projectId: string;
  /** Effective role rank is supplied by authorization state, never by model arguments. */
  roleRank?: () => number;
  /** Mints the internal HMAC token every non-router call to another worker in this codebase
   *  requires — injected rather than imported so this module has no @naelao/http dependency. */
  mintInternalToken: (secret: string, tenantId: string) => Promise<string>;
  /** Optional typed Jev/Laya sentry. Deterministic relevance remains the fail-closed fallback. */
  fastDecision?: FastDecisionGateway;
}

export function roleRankFor(role?: string | number): number {
  if (typeof role === "number") return Math.max(0, Math.min(3, Math.trunc(role)));
  switch (role) {
    case "owner": return 3;
    case "admin": return 2;
    case "editor":
    case "member": return 1;
    case "viewer":
    case "product_end_user": return 0;
    default: return 0;
  }
}

const FACT_RELEVANCE_CRITERIA = [
  "no semantic relation",
  "barely related",
  "weakly related",
  "somewhat related",
  "moderately related",
  "clearly related",
  "strongly related",
  "highly related",
  "nearly exact match",
  "exactly answers the query",
] as const;

/** Apply Jev/Laya to structured facts without making remote availability a correctness dependency. */
export async function gateStructuredFacts(
  query: string,
  candidates: MemoryRecallResult[],
  fastDecision?: FastDecisionGateway,
): Promise<MemoryRecallResult[]> {
  const deterministic = () => gateMemory(
    query,
    candidates.map((candidate) => ({
      ...candidate,
      relevance_score: candidate.relevance_score ?? projectFactRelevance(query, candidate.text),
      score: Math.min(candidate.score, candidate.relevance_score ?? projectFactRelevance(query, candidate.text)),
    })),
  );
  if (!fastDecision) return deterministic();
  const scored = await Promise.all(candidates.slice(0, 20).map(async (candidate) => {
    try {
      const decision = await fastDecision.score({
        state: { query, fact: candidate.text },
        instructions: "Score whether this durable project fact is relevant enough to answer the active query. Use semantic meaning, not just shared words.",
        criteria: FACT_RELEVANCE_CRITERIA,
        policyCode: "project_fact_relevance",
      });
      const confidence = decision.confidence ?? 0;
      const score = confidence >= 0.8 ? decision.value / (FACT_RELEVANCE_CRITERIA.length - 1) : 0;
      return { ...candidate, score: Math.min(candidate.score, score) };
    } catch {
      // A sentry outage cannot widen access. Recompute lexical relevance for this row rather
      // than returning its trust score unchanged (which would recreate the original leak).
      const relevance = candidate.relevance_score ?? projectFactRelevance(query, candidate.text);
      return { ...candidate, relevance_score: relevance, score: Math.min(candidate.score, relevance) };
    }
  }));
  return scored.filter((candidate) => Number.isFinite(candidate.score) && candidate.score >= 0.8)
    .sort((a, b) => b.score - a.score);
}

async function callSpacesWorker(
  opts: ProjectMemoryClientOptions,
  path: string,
  method: string,
  body?: unknown
): Promise<Response> {
  const token = await opts.mintInternalToken(opts.platformSecret, opts.tenantId);
  return opts.spacesWorker.fetch(new Request(
    `http://spaces-worker/spaces/${opts.spaceId}/projects/${opts.projectId}${path}`,
    {
      method,
      headers: { "content-type": "application/json", "x-naelao-tenant-id": opts.tenantId, "x-naelao-internal-token": token },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }
  ));
}

/** The project-scoped remote store — facts (L3) + fabric (L4) + wiki (L6) only. remember/recall/
 *  forget silently no-op on anything that isn't a structured fact (no entity/relation/attribute)
 *  — buildHybridMemoryStore is what routes episodic notes to the LOCAL store instead. */
export function buildProjectMemoryStore(opts: ProjectMemoryClientOptions): MemoryStore {
  return {
    async remember(entry) {
      if (!entry.entity || !entry.relation || !entry.attribute) return { id: "" }; // not a fact — hybrid wrapper won't call this path anyway
      const roleRank = roleRankFor(opts.roleRank?.());
      const resp = await callSpacesWorker(opts, `/memory/facts?role_rank=${roleRank}`, "POST", {
        entity: entry.entity, relation: entry.relation, attribute: entry.attribute,
      });
      if (!resp.ok) return { id: "" };
      return resp.json<{ id: string }>();
    },

    async recall(query) {
      const roleRank = roleRankFor(opts.roleRank?.());
      const resp = await callSpacesWorker(opts, `/memory/facts?q=${encodeURIComponent(query.text)}&limit=${query.limit ?? 5}&role_rank=${roleRank}`, "GET");
      if (!resp.ok) return [];
      const { data } = await resp.json<{ data: Array<{ id: string; entity: string; relation: string; attribute: string; trust_score: number; relevance_score?: number; required_role_rank?: number }> }>();
      const candidates = data.map((r): MemoryRecallResult => ({
        id: r.id, layer: "structured_fact", text: `${r.entity} ${r.relation} ${r.attribute}`,
        entity: r.entity, relation: r.relation, attribute: r.attribute,
        score: r.trust_score,
        role_rank: roleRank,
        ...(r.required_role_rank !== undefined ? { required_role_rank: r.required_role_rank } : {}),
        ...(r.relevance_score !== undefined ? { relevance_score: r.relevance_score } : {}),
      }));
      return gateStructuredFacts(query.text, candidates, opts.fastDecision);
    },

    async forget(id) {
      await callSpacesWorker(opts, `/memory/facts/${encodeURIComponent(id)}`, "DELETE").catch(() => {});
    },

    async recordFabric(entry) {
      const roleRank = roleRankFor(opts.roleRank?.());
      const resp = await callSpacesWorker(opts, `/memory/fabric?role_rank=${roleRank}`, "POST", {
        session_id: entry.sessionId, summary: entry.summary, key_insights: entry.keyInsights ?? [],
      });
      if (!resp.ok) return { id: "" };
      return resp.json<{ id: string }>();
    },

    async recallFabric(query) {
      const roleRank = roleRankFor(opts.roleRank?.());
      const resp = await callSpacesWorker(opts, `/memory/fabric?q=${encodeURIComponent(query.text)}&limit=${query.limit ?? 5}&role_rank=${roleRank}`, "GET");
      if (!resp.ok) return [];
      const { data } = await resp.json<{ data: Array<{ id: string; session_id: string; summary: string; key_insights: string; created_at: string; score: number; required_role_rank?: number }> }>();
      return data.map((r): FabricEntry => ({
        id: r.id, sessionId: r.session_id, summary: r.summary,
        keyInsights: JSON.parse(r.key_insights || "[]") as string[], score: r.score, createdAt: new Date(r.created_at).getTime(), ...(r.required_role_rank !== undefined ? { requiredRoleRank: r.required_role_rank } : {}),
      }));
    },

    async briefFabric(_userId, limit = 5) {
      const roleRank = roleRankFor(opts.roleRank?.());
      const resp = await callSpacesWorker(opts, `/memory/fabric/brief?limit=${limit}&role_rank=${roleRank}`, "GET");
      if (!resp.ok) return [];
      const { data } = await resp.json<{ data: Array<{ id: string; session_id: string; summary: string; key_insights: string; created_at: string; required_role_rank?: number }> }>();
      return data.map((r): FabricEntry => ({
        id: r.id, sessionId: r.session_id, summary: r.summary,
        keyInsights: JSON.parse(r.key_insights || "[]") as string[], score: 0, createdAt: new Date(r.created_at).getTime(), ...(r.required_role_rank !== undefined ? { requiredRoleRank: r.required_role_rank } : {}),
      }));
    },

    async upsertWikiConcept(entry) {
      const roleRank = roleRankFor(opts.roleRank?.());
      await callSpacesWorker(opts, `/memory/wiki?role_rank=${roleRank}`, "POST", {
        concept: entry.concept, definition: entry.definition, relationships: entry.relationships ?? [],
      });
      return { concept: entry.concept };
    },

    async lookupWikiConcept(_userId, concept) {
      const roleRank = roleRankFor(opts.roleRank?.());
      const resp = await callSpacesWorker(opts, `/memory/wiki/${encodeURIComponent(concept)}?role_rank=${roleRank}`, "GET");
      if (!resp.ok) return null;
      const { data } = await resp.json<{ data: { concept: string; definition: string; relationships: string; updated_at: string; required_role_rank?: number } | null }>();
      if (!data) return null;
      return { concept: data.concept, definition: data.definition, relationships: JSON.parse(data.relationships || "[]") as string[], updatedAt: new Date(data.updated_at).getTime(), ...(data.required_role_rank !== undefined ? { requiredRoleRank: data.required_role_rank } : {}) };
    },

    async searchWiki(query) {
      const roleRank = roleRankFor(opts.roleRank?.());
      const resp = await callSpacesWorker(opts, `/memory/wiki?q=${encodeURIComponent(query.text)}&limit=${query.limit ?? 5}&role_rank=${roleRank}`, "GET");
      if (!resp.ok) return [];
      const { data } = await resp.json<{ data: Array<{ concept: string; definition: string; relationships: string; updated_at: string; required_role_rank?: number }> }>();
      return data.map((r): WikiArticle => ({
        concept: r.concept, definition: r.definition, relationships: JSON.parse(r.relationships || "[]") as string[], updatedAt: new Date(r.updated_at).getTime(), ...(r.required_role_rank !== undefined ? { requiredRoleRank: r.required_role_rank } : {}),
      }));
    },
  };
}

/** Composes a local (per-thread-per-agent, Layer-5-capable) store with a project-scoped one.
 *  Facts (L3) and Fabric/Wiki (L4/L6) route to `project`; free-text episodic notes and semantic
 *  recall stay on `local`. `recall` merges both sides with the same dedupe-by-text/highest-score
 *  logic memory-os.ts's own recall() uses internally. */
export function buildHybridMemoryStore(local: MemoryStore, project: MemoryStore, fastDecision?: FastDecisionGateway): MemoryStore {
  return {
    async remember(entry) {
      if (entry.entity && entry.relation && entry.attribute) return project.remember(entry);
      return local.remember(entry);
    },

    async recall(query) {
      const limit = query.limit ?? 5;
      const [projectResults, localResults] = await Promise.all([
        project.recall(query).catch(() => [] as MemoryRecallResult[]),
        local.recall(query),
      ]);
      const seen = new Map<string, MemoryRecallResult>();
      for (const r of [...projectResults, ...localResults]) {
        const key = r.text.toLowerCase();
        const prior = seen.get(key);
        if (!prior || r.score > prior.score) seen.set(key, r);
      }
      const merged = [...seen.values()].sort((a, b) => b.score - a.score).slice(0, limit);
      const structured = await gateStructuredFacts(
        query.text,
        merged.filter((candidate) => candidate.layer === "structured_fact"),
        fastDecision,
      );
      const structuredIds = new Set(structured.map((candidate) => candidate.id));
      return merged.filter((candidate) => candidate.layer !== "structured_fact" || structuredIds.has(candidate.id));
    },

    async forget(id) {
      await Promise.all([project.forget(id).catch(() => {}), local.forget(id)]);
    },

    recordFabric: (entry) => project.recordFabric(entry),
    recallFabric: (query) => project.recallFabric(query),
    briefFabric: (userId, limit) => project.briefFabric(userId, limit),
    upsertWikiConcept: (entry) => project.upsertWikiConcept(entry),
    lookupWikiConcept: (userId, concept) => project.lookupWikiConcept(userId, concept),
    searchWiki: (query) => project.searchWiki(query),
  };
}
