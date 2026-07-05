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

export interface ProjectMemoryClientOptions {
  spacesWorker: Fetcher;
  platformSecret: string;
  spaceId: string;
  tenantId: string;
  projectId: string;
  /** Mints the internal HMAC token every non-router call to another worker in this codebase
   *  requires — injected rather than imported so this module has no @naelao/http dependency. */
  mintInternalToken: (secret: string, tenantId: string) => Promise<string>;
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
      const resp = await callSpacesWorker(opts, "/memory/facts", "POST", {
        entity: entry.entity, relation: entry.relation, attribute: entry.attribute,
      });
      if (!resp.ok) return { id: "" };
      return resp.json<{ id: string }>();
    },

    async recall(query) {
      const resp = await callSpacesWorker(opts, `/memory/facts?q=${encodeURIComponent(query.text)}&limit=${query.limit ?? 5}`, "GET");
      if (!resp.ok) return [];
      const { data } = await resp.json<{ data: Array<{ id: string; entity: string; relation: string; attribute: string; trust_score: number }> }>();
      return data.map((r): MemoryRecallResult => ({
        id: r.id, layer: "structured_fact", text: `${r.entity} ${r.relation} ${r.attribute}`,
        entity: r.entity, relation: r.relation, attribute: r.attribute, score: r.trust_score,
      }));
    },

    async forget(id) {
      await callSpacesWorker(opts, `/memory/facts/${encodeURIComponent(id)}`, "DELETE").catch(() => {});
    },

    async recordFabric(entry) {
      const resp = await callSpacesWorker(opts, "/memory/fabric", "POST", {
        session_id: entry.sessionId, summary: entry.summary, key_insights: entry.keyInsights ?? [],
      });
      if (!resp.ok) return { id: "" };
      return resp.json<{ id: string }>();
    },

    async recallFabric(query) {
      const resp = await callSpacesWorker(opts, `/memory/fabric?q=${encodeURIComponent(query.text)}&limit=${query.limit ?? 5}`, "GET");
      if (!resp.ok) return [];
      const { data } = await resp.json<{ data: Array<{ id: string; session_id: string; summary: string; key_insights: string; created_at: string; score: number }> }>();
      return data.map((r): FabricEntry => ({
        id: r.id, sessionId: r.session_id, summary: r.summary,
        keyInsights: JSON.parse(r.key_insights || "[]") as string[], score: r.score, createdAt: new Date(r.created_at).getTime(),
      }));
    },

    async briefFabric(_userId, limit = 5) {
      const resp = await callSpacesWorker(opts, `/memory/fabric/brief?limit=${limit}`, "GET");
      if (!resp.ok) return [];
      const { data } = await resp.json<{ data: Array<{ id: string; session_id: string; summary: string; key_insights: string; created_at: string }> }>();
      return data.map((r): FabricEntry => ({
        id: r.id, sessionId: r.session_id, summary: r.summary,
        keyInsights: JSON.parse(r.key_insights || "[]") as string[], score: 0, createdAt: new Date(r.created_at).getTime(),
      }));
    },

    async upsertWikiConcept(entry) {
      await callSpacesWorker(opts, "/memory/wiki", "POST", {
        concept: entry.concept, definition: entry.definition, relationships: entry.relationships ?? [],
      });
      return { concept: entry.concept };
    },

    async lookupWikiConcept(_userId, concept) {
      const resp = await callSpacesWorker(opts, `/memory/wiki/${encodeURIComponent(concept)}`, "GET");
      if (!resp.ok) return null;
      const { data } = await resp.json<{ data: { concept: string; definition: string; relationships: string; updated_at: string } | null }>();
      if (!data) return null;
      return { concept: data.concept, definition: data.definition, relationships: JSON.parse(data.relationships || "[]") as string[], updatedAt: new Date(data.updated_at).getTime() };
    },

    async searchWiki(query) {
      const resp = await callSpacesWorker(opts, `/memory/wiki?q=${encodeURIComponent(query.text)}&limit=${query.limit ?? 5}`, "GET");
      if (!resp.ok) return [];
      const { data } = await resp.json<{ data: Array<{ concept: string; definition: string; relationships: string; updated_at: string }> }>();
      return data.map((r): WikiArticle => ({
        concept: r.concept, definition: r.definition, relationships: JSON.parse(r.relationships || "[]") as string[], updatedAt: new Date(r.updated_at).getTime(),
      }));
    },
  };
}

/** Composes a local (per-thread-per-agent, Layer-5-capable) store with a project-scoped one.
 *  Facts (L3) and Fabric/Wiki (L4/L6) route to `project`; free-text episodic notes and semantic
 *  recall stay on `local`. `recall` merges both sides with the same dedupe-by-text/highest-score
 *  logic memory-os.ts's own recall() uses internally. */
export function buildHybridMemoryStore(local: MemoryStore, project: MemoryStore): MemoryStore {
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
      return [...seen.values()].sort((a, b) => b.score - a.score).slice(0, limit);
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
