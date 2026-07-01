/**
 * wiki (Memory OS Layer 6 — spec "6-Layer Memory OS", byte ~148238: "Auto-curated concept and
 * entity vault. An async background process (wiki-continuous-ingest) runs on session end to
 * structure new learnings into wiki articles, which are re-indexed into Layer 5.").
 *
 * Same self-managed pattern as fabric/memory: the agent calls wiki.upsert when it learns
 * something worth defining durably (a customer's product terminology, a recurring entity),
 * and wiki.lookup/wiki.search to consult what's already been curated before re-deriving it.
 * "Re-indexed into Layer 5" (Vectorize) is a further enhancement noted as future work — this
 * build makes the vault itself (the DO SQLite + R2 primitive per spec) real and queryable.
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";

function userIdFor(args: Record<string, unknown>, ctx: PrebuiltOpContext): string | undefined {
  const explicit = args["user_id"];
  if (typeof explicit === "string" && explicit) return explicit;
  return ctx.env.userId;
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export const wiki: PrebuiltScript = {
  name: "wiki",
  description:
    "Auto-curated concept vault (Layer 6): define or update a concept/entity, look one up by name, or search definitions by keyword.",
  domain: "knowledge",
  requires_tier: 1,
  operations: {
    async "wiki.upsert"(args, ctx) {
      if (!ctx.env.memoryStore) return { ok: false, reason: "memory store not available in this environment" };
      const concept = String(args["concept"] ?? "");
      const definition = String(args["definition"] ?? "");
      if (!concept || !definition) throw new Error("wiki.upsert requires 'concept' and 'definition'");
      const userId = userIdFor(args, ctx);
      return ctx.env.memoryStore.upsertWikiConcept({
        ...(userId ? { userId } : {}),
        concept,
        definition,
        relationships: stringArray(args["relationships"]),
      });
    },
    async "wiki.lookup"(args, ctx) {
      if (!ctx.env.memoryStore) return { ok: false, reason: "memory store not available in this environment" };
      const concept = String(args["concept"] ?? "");
      if (!concept) throw new Error("wiki.lookup requires 'concept'");
      const userId = userIdFor(args, ctx);
      const article = await ctx.env.memoryStore.lookupWikiConcept(userId, concept);
      return article ?? { ok: false, reason: "concept not found" };
    },
    async "wiki.search"(args, ctx) {
      if (!ctx.env.memoryStore) return { ok: false, reason: "memory store not available in this environment" };
      const text = String(args["query"] ?? args["text"] ?? "");
      if (!text) throw new Error("wiki.search requires 'query'");
      const userId = userIdFor(args, ctx);
      return ctx.env.memoryStore.searchWiki({
        ...(userId ? { userId } : {}),
        text,
        limit: typeof args["limit"] === "number" ? (args["limit"] as number) : 5,
      });
    },
  },
};
