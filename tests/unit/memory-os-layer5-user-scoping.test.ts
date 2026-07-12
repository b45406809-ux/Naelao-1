import { describe, it, expect, vi } from "vitest";
import { initMemorySchema, buildMemoryStore } from "../../workers/agents/src/script-engine/memory-os.js";
import type { Embedder, VectorIndex } from "../../workers/agents/src/script-engine/types.js";
import { createDOSqlStorage } from "./helpers/sqlite-do-shim.js";

// §A1.19 regression test: the wrangler.toml binding comment for MEMORY_VECTORIZE has always
// claimed Layer 5 (episodic→semantic) recall is "queried by embedding + user_id filter" — but
// until this fix, the actual Vectorize query only ever filtered by spaceId, so one user's
// promoted episodic memories were recallable by every other user sharing the same space/DO in
// shared-assistant mode. This proves the fix: a scoped user's query only ever sees their own
// promoted memories plus genuinely space-level (unscoped) ones, never another user's.

function makeVectorIndex(matchesByUserId: Record<string, Array<{ id: string; score: number; text: string }>>): VectorIndex {
  const query = vi.fn(async (_vec: number[], opts: { filter?: Record<string, unknown> }) => {
    const filter = opts.filter as { userId?: { $eq?: string } } | undefined;
    const scopedUserId = filter?.userId?.$eq ?? "";
    const matches = (matchesByUserId[scopedUserId] ?? []).map((m) => ({
      id: m.id,
      score: m.score,
      metadata: { text: m.text, userId: scopedUserId },
    }));
    return { matches };
  });
  return { upsert: vi.fn(), query, deleteByIds: vi.fn() };
}

describe("Memory OS Layer 5 — semantic recall is scoped per user, not just per space", () => {
  it("a scoped user's query never surfaces another user's promoted semantic memory", async () => {
    const sql = createDOSqlStorage();
    initMemorySchema(sql as never);
    const embedder: Embedder = { embed: vi.fn().mockResolvedValue([0.1, 0.2]) };
    const vectorIndex = makeVectorIndex({
      alice: [{ id: "sem-alice", score: 0.9, text: "alice's private long-term memory" }],
      bob: [{ id: "sem-bob", score: 0.9, text: "bob's private long-term memory" }],
      "": [{ id: "sem-space", score: 0.9, text: "space-level shared memory" }],
    });
    const store = buildMemoryStore({ sql: sql as never, spaceId: "space1", vectorIndex, embedder });

    const bobResults = await store.recall({ userId: "bob", text: "memory" });
    expect(bobResults.some((r) => r.text === "bob's private long-term memory")).toBe(true);
    expect(bobResults.some((r) => r.text === "alice's private long-term memory")).toBe(false);
    // Space-level (unscoped) memories still surface for a scoped user — only cross-USER leakage
    // is closed, not the intentional space-wide sharing tier.
    expect(bobResults.some((r) => r.text === "space-level shared memory")).toBe(true);
  });

  it("queries with both the user's own scope and the space-level scope (never just spaceId alone)", async () => {
    const sql = createDOSqlStorage();
    initMemorySchema(sql as never);
    const embedder: Embedder = { embed: vi.fn().mockResolvedValue([0.1, 0.2]) };
    const vectorIndex = makeVectorIndex({});
    const store = buildMemoryStore({ sql: sql as never, spaceId: "space1", vectorIndex, embedder });

    await store.recall({ userId: "carol", text: "anything" });
    const calledFilters = (vectorIndex.query as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1].filter);
    expect(calledFilters).toContainEqual({ spaceId: { $eq: "space1" }, userId: { $eq: "carol" } });
    expect(calledFilters).toContainEqual({ spaceId: { $eq: "space1" }, userId: { $eq: "" } });
  });

  it("an unscoped (space-level) query issues only one query, not a duplicate", async () => {
    const sql = createDOSqlStorage();
    initMemorySchema(sql as never);
    const embedder: Embedder = { embed: vi.fn().mockResolvedValue([0.1, 0.2]) };
    const vectorIndex = makeVectorIndex({});
    const store = buildMemoryStore({ sql: sql as never, spaceId: "space1", vectorIndex, embedder });

    await store.recall({ text: "anything" });
    expect(vectorIndex.query).toHaveBeenCalledTimes(1);
  });
});
