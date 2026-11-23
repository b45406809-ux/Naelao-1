import { describe, expect, it, vi } from "vitest";
import { buildMemoryStore, type SqlStorageLike } from "./memory-os.js";

function fixture(owners: { facts: string[]; episodes: string[] }) {
  const deleted: string[] = [];
  const vectorDelete = vi.fn(async () => undefined);
  const sql: SqlStorageLike = {
    exec(query, ...params) {
      const [id, userId] = params as [string, string];
      if (query.startsWith("SELECT 1 AS found FROM structured_facts")) return { toArray: () => owners.facts.includes(`${id}:${userId}`) ? [{ found: 1 }] : [] };
      if (query.startsWith("SELECT 1 AS found FROM episodic_log")) return { toArray: () => owners.episodes.includes(`${id}:${userId}`) ? [{ found: 1 }] : [] };
      if (query.startsWith("DELETE FROM structured_facts") || query.startsWith("DELETE FROM episodic_log")) {
        deleted.push(`${query.startsWith("DELETE FROM structured_facts") ? "fact" : "episode"}:${id}:${userId}`);
      }
      return { toArray: () => [] };
    },
  };
  return { store: buildMemoryStore({ sql, spaceId: "space", tenantId: "tenant", vectorIndex: { deleteByIds: vectorDelete } as never }), deleted, vectorDelete };
}

describe("Memory OS scoped deletion", () => {
  it("cannot delete another user's fact or semantic vector by ID", async () => {
    const f = fixture({ facts: ["secret:bob"], episodes: ["secret:bob"] });
    await f.store.forget("secret", "alice");
    expect(f.deleted).toEqual([]);
    expect(f.vectorDelete).not.toHaveBeenCalled();
  });

  it("deletes only matching actor rows and its promoted semantic vector", async () => {
    const f = fixture({ facts: ["fact:alice", "fact:bob"], episodes: ["episode:alice", "episode:bob"] });
    await f.store.forget("fact", "alice");
    expect(f.deleted).toEqual(["fact:fact:alice", "episode:fact:alice"]);
    expect(f.vectorDelete).not.toHaveBeenCalled();
    f.deleted.length = 0;
    await f.store.forget("episode", "alice");
    expect(f.deleted).toEqual(["fact:episode:alice", "episode:episode:alice"]);
    expect(f.vectorDelete).toHaveBeenCalledWith(["episode"]);
    expect(f.deleted).not.toContain("fact:fact:bob");
    expect(f.deleted).not.toContain("episode:episode:bob");
  });

  it("does not recall a deleted promoted episode when Vectorize cleanup fails", async () => {
    const episodes = [
      { id: "deleted-episode", user_id: "alice", promoted: 1 },
      { id: "live-episode", user_id: "alice", promoted: 1 },
    ];
    const vectorDelete = vi.fn(async () => { throw new Error("vectorize_unavailable"); });
    const sql: SqlStorageLike = {
      exec(query, ...params) {
        if (query.startsWith("SELECT 1 AS found FROM structured_facts")) return { toArray: () => [] };
        if (query.startsWith("SELECT 1 AS found FROM episodic_log")) {
          const [id, userId] = params as [string, string];
          return { toArray: () => episodes.some((row) => row.id === id && row.user_id === userId) ? [{ found: 1 }] : [] };
        }
        if (query.startsWith("DELETE FROM episodic_log")) {
          const [id, userId] = params as [string, string];
          const index = episodes.findIndex((row) => row.id === id && row.user_id === userId);
          if (index >= 0) episodes.splice(index, 1);
          return { toArray: () => [] };
        }
        if (query.startsWith("SELECT id,user_id FROM episodic_log")) {
          const [actorId, unscoped, ...ids] = params as string[];
          return { toArray: () => episodes.filter((row) => ids.includes(row.id)
            && (row.user_id === actorId || row.user_id === unscoped)) };
        }
        return { toArray: () => [] };
      },
    };
    const vectorIndex = {
      deleteByIds: vectorDelete,
      query: vi.fn(async (_vector: number[], options: { filter?: Record<string, unknown> }) => {
        const filter = options.filter?.["userId"] as { $eq?: string } | undefined;
        if (filter?.$eq !== "alice") return { matches: [] };
        return { matches: [
          { id: "deleted-episode", score: 0.99, metadata: { text: "deleted private note", userId: "alice" } },
          { id: "live-episode", score: 0.95, metadata: { text: "live private note", userId: "alice" } },
        ] };
      }),
    };
    const store = buildMemoryStore({ sql, spaceId: "space", tenantId: "tenant", vectorIndex: vectorIndex as never,
      embedder: { embed: async () => [1] } });

    await store.forget("deleted-episode", "alice");
    const recalled = await store.recall({ userId: "alice", text: "private note", limit: 5 });

    expect(vectorDelete).toHaveBeenCalledWith(["deleted-episode"]);
    expect(recalled.map((row) => row.id)).toEqual(["live-episode"]);
    expect(recalled[0]).toMatchObject({ user_id: "alice", text: "live private note" });
  });
});
