import { describe, it, expect, vi } from "vitest";
import { initMemorySchema, buildMemoryStore, runMemoryMaintenance, type SqlStorageLike } from "../../workers/agents/src/script-engine/memory-os.js";
import type { Embedder, VectorIndex } from "../../workers/agents/src/script-engine/types.js";

// In-memory fake of the DO SQLite surface — enough relational behavior (WHERE, IN, LIKE,
// ORDER BY, UNIQUE) to exercise memory-os.ts without a real Durable Object.
function fakeSql(): SqlStorageLike & { rows: { structured_facts: any[]; episodic_log: any[] } } {
  const rows = { structured_facts: [] as any[], episodic_log: [] as any[] };
  return {
    rows,
    exec(query: string, ...params: unknown[]) {
      const q = query.trim();

      if (/^CREATE|^PRAGMA/i.test(q)) return { toArray: () => [] };

      if (/^INSERT INTO structured_facts/i.test(q)) {
        const [id, user_id, entity, relation, attribute, trust_score, decay_rate, last_used, updated_at] = params;
        rows.structured_facts.push({ id, user_id, entity, relation, attribute, trust_score, decay_rate, last_used, updated_at });
        return { toArray: () => [] };
      }
      if (/^UPDATE structured_facts SET attribute/i.test(q)) {
        const [attribute, trust_score, last_used, updated_at, id] = params;
        const r = rows.structured_facts.find((f) => f.id === id);
        if (r) Object.assign(r, { attribute, trust_score, last_used, updated_at });
        return { toArray: () => [] };
      }
      if (/^UPDATE structured_facts SET trust_score/i.test(q)) {
        const [trust_score, updated_at, id] = params;
        const r = rows.structured_facts.find((f) => f.id === id);
        if (r) Object.assign(r, { trust_score, updated_at });
        return { toArray: () => [] };
      }
      if (/^UPDATE structured_facts SET last_used/i.test(q)) {
        const idsStart = q.indexOf("IN (") + 4;
        const count = q.slice(idsStart).split(",").length;
        const ids = params.slice(0, count);
        for (const id of ids) {
          const r = rows.structured_facts.find((f) => f.id === id);
          if (r) r.last_used = Date.now();
        }
        return { toArray: () => [] };
      }
      if (/^DELETE FROM structured_facts/i.test(q)) {
        const [id] = params;
        rows.structured_facts = rows.structured_facts.filter((f) => f.id !== id);
        return { toArray: () => [] };
      }
      if (/^SELECT id FROM structured_facts WHERE user_id = \? AND entity = \? AND relation = \?/i.test(q)) {
        const [user_id, entity, relation] = params;
        return { toArray: () => rows.structured_facts.filter((f) => f.user_id === user_id && f.entity === entity && f.relation === relation).map((f) => ({ id: f.id })) };
      }
      if (/SELECT \* FROM structured_facts\s+WHERE user_id IN/i.test(q)) {
        // Recall matches on TOKENS, so the number of LIKE params is variable (3 per token) —
        // this used to destructure a fixed [like1, like2, like3, limit] and read `limit` at a
        // fixed index, which silently became a string the moment the query grew. Parse the real
        // shape instead: two user ids, then 3N like terms, then the limit.
        const u1 = params[0] as string;
        const u2 = params[1] as string;
        const limit = params[params.length - 1] as number;
        const likes = params.slice(2, params.length - 1) as string[];
        const needles = [...new Set(likes.map((l) => String(l).replace(/^%|%$/g, "").replace(/\\([%_])/g, "$1").toLowerCase()))];
        const hit = (f: any) =>
          needles.some(
            (n) =>
              f.entity.toLowerCase().includes(n) ||
              f.relation.toLowerCase().includes(n) ||
              f.attribute.toLowerCase().includes(n)
          );
        return {
          toArray: () =>
            rows.structured_facts
              .filter((f) => f.user_id === u1 || f.user_id === u2)
              .filter(hit)
              .sort((a, b) => b.trust_score - a.trust_score)
              .slice(0, limit),
        };
      }
      if (/^SELECT \* FROM structured_facts WHERE \? - last_used >= \?/i.test(q)) {
        const [now, tick] = params as [number, number];
        return { toArray: () => rows.structured_facts.filter((f) => now - f.last_used >= tick) };
      }

      if (/^INSERT INTO episodic_log/i.test(q)) {
        const [id, user_id, text, importance, , created_at] = params;
        rows.episodic_log.push({ id, user_id, text, importance, promoted: 0, created_at });
        return { toArray: () => [] };
      }
      if (/^UPDATE episodic_log SET promoted/i.test(q)) {
        const [id] = params;
        const r = rows.episodic_log.find((e) => e.id === id);
        if (r) r.promoted = 1;
        return { toArray: () => [] };
      }
      if (/^DELETE FROM episodic_log WHERE id = \?$/i.test(q)) {
        const [id] = params;
        rows.episodic_log = rows.episodic_log.filter((e) => e.id !== id);
        return { toArray: () => [] };
      }
      if (/^SELECT \* FROM episodic_log WHERE user_id IN/i.test(q)) {
        const [u1, u2, like, limit] = params as [string, string, string, number];
        const needle = String(like).replace(/^%|%$/g, "").replace(/\\([%_])/g, "$1").toLowerCase();
        return {
          toArray: () =>
            rows.episodic_log
              .filter((e) => e.user_id === u1 || e.user_id === u2)
              .filter((e) => e.text.toLowerCase().includes(needle))
              .sort((a, b) => b.created_at - a.created_at)
              .slice(0, limit),
        };
      }
      if (/^SELECT \* FROM episodic_log WHERE promoted = 0 AND importance >= \?/i.test(q)) {
        const [floor, limit] = params as [number, number];
        return { toArray: () => rows.episodic_log.filter((e) => e.promoted === 0 && e.importance >= floor).sort((a, b) => b.importance - a.importance).slice(0, limit) };
      }
      if (/^SELECT id FROM episodic_log WHERE promoted = 0 ORDER BY created_at DESC LIMIT \?/i.test(q)) {
        const [limit] = params as [number];
        return { toArray: () => rows.episodic_log.filter((e) => e.promoted === 0).sort((a, b) => b.created_at - a.created_at).slice(0, limit).map((e) => ({ id: e.id })) };
      }
      if (/^SELECT COUNT\(\*\) AS c FROM episodic_log WHERE promoted = 0/i.test(q)) {
        return { toArray: () => [{ c: rows.episodic_log.filter((e) => e.promoted === 0).length }] };
      }
      if (/^DELETE FROM episodic_log WHERE promoted = 0 AND id NOT IN/i.test(q)) {
        const keep = new Set(params as string[]);
        rows.episodic_log = rows.episodic_log.filter((e) => e.promoted !== 0 || keep.has(e.id));
        return { toArray: () => [] };
      }

      throw new Error(`fakeSql: unhandled query: ${q}`);
    },
  };
}

describe("memory-os — structured facts (Layer 3)", () => {
  it("remember + recall round-trips a fact scoped to a user", async () => {
    const sql = fakeSql();
    initMemorySchema(sql);
    const store = buildMemoryStore({ sql, spaceId: "space1" });

    await store.remember({ userId: "alice", text: "prefers email", entity: "alice", relation: "prefers_channel", attribute: "email" });
    const results = await store.recall({ userId: "alice", text: "channel" });
    expect(results[0]?.layer).toBe("structured_fact");
    expect(results[0]?.attribute).toBe("email");
  });

  it("two users' facts never bleed into each other (G-AN26 namespace collision)", async () => {
    const sql = fakeSql();
    initMemorySchema(sql);
    const store = buildMemoryStore({ sql, spaceId: "space1" });

    await store.remember({ userId: "alice", text: "x", entity: "user", relation: "favorite_color", attribute: "blue" });
    await store.remember({ userId: "bob", text: "x", entity: "user", relation: "favorite_color", attribute: "red" });

    const aliceResults = await store.recall({ userId: "alice", text: "favorite_color" });
    const bobResults = await store.recall({ userId: "bob", text: "favorite_color" });
    expect(aliceResults.map((r) => r.attribute)).toEqual(["blue"]);
    expect(bobResults.map((r) => r.attribute)).toEqual(["red"]);
  });

  it("re-stating a fact merges (same entity+relation+user) rather than duplicating", async () => {
    const sql = fakeSql();
    initMemorySchema(sql);
    const store = buildMemoryStore({ sql, spaceId: "space1" });
    const a = await store.remember({ userId: "alice", text: "x", entity: "alice", relation: "role", attribute: "admin" });
    const b = await store.remember({ userId: "alice", text: "x", entity: "alice", relation: "role", attribute: "owner" });
    expect(a.id).toBe(b.id);
    expect(sql.rows.structured_facts.length).toBe(1);
    expect(sql.rows.structured_facts[0].attribute).toBe("owner");
  });

  it("space-level facts (no userId) are visible to every user's recall", async () => {
    const sql = fakeSql();
    initMemorySchema(sql);
    const store = buildMemoryStore({ sql, spaceId: "space1" });
    await store.remember({ text: "the space timezone is UTC", entity: "space", relation: "timezone", attribute: "UTC" });
    const results = await store.recall({ userId: "anyone", text: "timezone" });
    expect(results[0]?.attribute).toBe("UTC");
  });

  it("forget deletes the fact", async () => {
    const sql = fakeSql();
    initMemorySchema(sql);
    const store = buildMemoryStore({ sql, spaceId: "space1" });
    const { id } = await store.remember({ userId: "alice", text: "x", entity: "a", relation: "b", attribute: "c" });
    await store.forget(id);
    const results = await store.recall({ userId: "alice", text: "b" });
    expect(results).toHaveLength(0);
  });
});

describe("memory-os — episodic notes + semantic recall", () => {
  it("free-text remember (no entity/relation) lands in the episodic log", async () => {
    const sql = fakeSql();
    initMemorySchema(sql);
    const store = buildMemoryStore({ sql, spaceId: "space1" });
    await store.remember({ userId: "alice", text: "customer was frustrated about shipping delay", importance: 0.9 });
    expect(sql.rows.episodic_log).toHaveLength(1);
    expect(sql.rows.episodic_log[0].importance).toBe(0.9);
  });

  it("recall merges semantic (Vectorize) hits above the score floor with structured/episodic", async () => {
    const sql = fakeSql();
    initMemorySchema(sql);
    const embedder: Embedder = { embed: vi.fn().mockResolvedValue([0.1, 0.2]) };
    const vectorIndex: VectorIndex = {
      upsert: vi.fn(),
      query: vi.fn().mockResolvedValue({
        matches: [
          { id: "sem1", score: 0.9, metadata: { text: "long-term insight", userId: "alice" } },
          { id: "sem2", score: 0.8, metadata: { text: "at floor, excluded" } },
          { id: "sem3", score: 0.800_001, metadata: { text: "above floor, included", userId: "alice" } },
        ],
      }),
      deleteByIds: vi.fn(),
    };
    const store = buildMemoryStore({ sql, spaceId: "space1", vectorIndex, embedder });
    const results = await store.recall({ userId: "alice", text: "insight" });
    expect(results.some((r) => r.layer === "semantic" && r.text === "long-term insight")).toBe(true);
    expect(results.some((r) => r.text === "at floor, excluded")).toBe(false);
    expect(results.some((r) => r.text === "above floor, included")).toBe(true);
  });
});

describe("memory-os — maintenance (decay, promotion, pruning)", () => {
  it("decays a fact's trust_score and prunes it once it crosses the floor", async () => {
    const sql = fakeSql();
    initMemorySchema(sql);
    const store = buildMemoryStore({ sql, spaceId: "space1" });
    await store.remember({ userId: "alice", text: "x", entity: "a", relation: "b", attribute: "c" });
    // Force last_used far enough in the past that decay crosses the prune floor.
    sql.rows.structured_facts[0].last_used = Date.now() - 365 * 24 * 60 * 60 * 1000;
    sql.rows.structured_facts[0].decay_rate = 0.5;

    const result = await runMemoryMaintenance({ sql, spaceId: "space1" });
    expect(result.pruned_facts).toBe(1);
    expect(sql.rows.structured_facts).toHaveLength(0);
  });

  it("promotes high-importance episodic notes to the semantic (Vectorize) layer", async () => {
    const sql = fakeSql();
    initMemorySchema(sql);
    const store = buildMemoryStore({ sql, spaceId: "space1" });
    await store.remember({ userId: "alice", text: "important fact worth remembering forever", importance: 0.95 });
    await store.remember({ userId: "alice", text: "trivial chit-chat", importance: 0.1 });

    const embedder: Embedder = { embed: vi.fn().mockResolvedValue([0.1, 0.2]) };
    const vectorIndex: VectorIndex = { upsert: vi.fn().mockResolvedValue({}), query: vi.fn(), deleteByIds: vi.fn() };

    const result = await runMemoryMaintenance({ sql, spaceId: "space1", vectorIndex, embedder });
    expect(result.promoted).toBe(1);
    expect(vectorIndex.upsert).toHaveBeenCalledTimes(1);
    expect(sql.rows.episodic_log.find((e) => e.importance === 0.95)?.promoted).toBe(1);
    expect(sql.rows.episodic_log.find((e) => e.importance === 0.1)?.promoted).toBe(0);
  });

  it("never promotes without a vectorIndex/embedder (no silent data loss)", async () => {
    const sql = fakeSql();
    initMemorySchema(sql);
    const store = buildMemoryStore({ sql, spaceId: "space1" });
    await store.remember({ userId: "alice", text: "important", importance: 0.9 });
    const result = await runMemoryMaintenance({ sql, spaceId: "space1" });
    expect(result.promoted).toBe(0);
  });
});
