import { describe, it, expect, vi } from "vitest";
import { initMemorySchema, buildMemoryStore } from "../../workers/agents/src/script-engine/memory-os.js";
import type { MemoryStore } from "../../workers/agents/src/script-engine/types.js";
import { createDOSqlStorage } from "./helpers/sqlite-do-shim.js";

// §A1.19: Memory OS Layer 6 (Wiki) gains an optional AutoRAG-backed assist. SQLite stays
// authoritative for CRUD (unchanged from before this feature existed) — the R2 mirror + AutoRAG
// query are purely additive, best-effort, and degrade honestly to the pre-existing LIKE-match
// search when unconfigured.

function makeStore(opts: { wikiBucket?: { put: ReturnType<typeof vi.fn> }; autoRag?: { search: ReturnType<typeof vi.fn> } } = {}): MemoryStore {
  const sql = createDOSqlStorage();
  initMemorySchema(sql as never);
  return buildMemoryStore({ sql: sql as never, spaceId: "space1", ...opts });
}

describe("Memory OS Layer 6 (Wiki) — AutoRAG mirror + assist", () => {
  it("mirrors an upserted concept to R2 when wikiBucket is configured", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const store = makeStore({ wikiBucket: { put } });
    await store.upsertWikiConcept({ userId: "u1", concept: "refund window", definition: "30 days from purchase." });
    expect(put).toHaveBeenCalledTimes(1);
    const [key, body] = put.mock.calls[0]!;
    expect(key).toBe("spaces/space1/memory/wiki/u1/refund-window.md");
    expect(body).toContain("30 days from purchase.");
  });

  it("upsert succeeds even when the R2 mirror write fails (best-effort, SQLite is authoritative)", async () => {
    const put = vi.fn().mockRejectedValue(new Error("R2 unavailable"));
    const store = makeStore({ wikiBucket: { put } });
    const result = await store.upsertWikiConcept({ userId: "u1", concept: "x", definition: "y" });
    expect(result.concept).toBe("x");
    const article = await store.lookupWikiConcept("u1", "x");
    expect(article?.definition).toBe("y");
  });

  it("upsert works identically with no wikiBucket configured at all (unaffected by this feature)", async () => {
    const store = makeStore();
    const result = await store.upsertWikiConcept({ userId: "u1", concept: "x", definition: "y" });
    expect(result.concept).toBe("x");
  });

  it("searchWiki falls back to plain LIKE-match when autoRag is not configured", async () => {
    const store = makeStore();
    await store.upsertWikiConcept({ userId: "u1", concept: "refund_window", definition: "30 days from purchase." });
    const results = await store.searchWiki({ userId: "u1", text: "refund" });
    expect(results).toHaveLength(1);
    expect(results[0]!.concept).toBe("refund_window");
  });

  it("merges AutoRAG-matched concepts (re-hydrated from SQLite) with the direct LIKE search", async () => {
    const search = vi.fn().mockResolvedValue([{ concept: "return_policy", score: 0.8 }]);
    const store = makeStore({ autoRag: { search } });
    // "return_policy" doesn't contain the literal substring "refund", so the plain LIKE search
    // alone would never find it — only the AutoRAG assist (semantic match) surfaces it.
    await store.upsertWikiConcept({ userId: "u1", concept: "return_policy", definition: "Items may be returned within 30 days." });
    const results = await store.searchWiki({ userId: "u1", text: "refund" });
    expect(search).toHaveBeenCalledWith("refund", { topK: 5 });
    expect(results.some((r) => r.concept === "return_policy")).toBe(true);
  });

  it("never fabricates a WikiArticle from AutoRAG alone — a concept AutoRAG names but SQLite no longer has is silently skipped", async () => {
    const search = vi.fn().mockResolvedValue([{ concept: "deleted_concept", score: 0.9 }]);
    const store = makeStore({ autoRag: { search } });
    const results = await store.searchWiki({ userId: "u1", text: "anything" });
    expect(results.some((r) => r.concept === "deleted_concept")).toBe(false);
  });

  it("searchWiki degrades to LIKE-match results when the AutoRAG call itself throws", async () => {
    const search = vi.fn().mockRejectedValue(new Error("AutoRAG unavailable"));
    const store = makeStore({ autoRag: { search } });
    await store.upsertWikiConcept({ userId: "u1", concept: "shipping_zone", definition: "Determines delivery time." });
    const results = await store.searchWiki({ userId: "u1", text: "shipping" });
    expect(results.some((r) => r.concept === "shipping_zone")).toBe(true);
  });

  it("does not call AutoRAG once the LIKE search alone already fills the requested limit", async () => {
    const search = vi.fn().mockResolvedValue([]);
    const store = makeStore({ autoRag: { search } });
    await store.upsertWikiConcept({ userId: "u1", concept: "refund_window", definition: "30 days." });
    await store.searchWiki({ userId: "u1", text: "refund", limit: 1 });
    expect(search).not.toHaveBeenCalled();
  });
});
