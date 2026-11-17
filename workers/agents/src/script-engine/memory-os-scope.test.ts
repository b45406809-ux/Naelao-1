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
});
