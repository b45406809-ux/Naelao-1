import { describe, it, expect } from "vitest";
import { NaelaoAgentDO } from "../../workers/agents/src/do/NaelaoAgentDO.js";
import { createDOStorage } from "./helpers/sqlite-do-shim.js";

// "seems like the ai is not recording anything in memory yet why"
//
// It was recording. GET /memory (what the shell's Memory panel renders) read `agent_memory` — the
// original key/value store, written only by this DO's own POST /memory, which nothing in the
// script-native agent loop calls. Every memory the agent actually forms goes through Memory OS:
// `structured_facts` (memory.remember) and `episodic_log` (the automatic post-run note). So the
// panel read a table nothing writes and showed an empty list however much had been stored.
//
// Verified live before the fix: a real multi-step run completed, and GET /assistant/memory returned
// {"entries":[],"count":0}.

function makeDO(): { doInstance: NaelaoAgentDO; storage: ReturnType<typeof createDOStorage> } {
  const storage = createDOStorage();
  const doInstance = new NaelaoAgentDO(
    { storage } as never,
    { PLATFORM_SECRET: "test-secret" } as never
  );
  return { doInstance, storage };
}

async function getMemory(doInstance: NaelaoAgentDO, category?: string): Promise<any> {
  const resp = await doInstance.fetch(
    new Request(`http://agent-do/memory${category ? `?category=${category}` : ""}`)
  );
  return resp.json();
}

/** Create the Memory OS tables the same shape memory-os.ts does, then seed them. */
function seedMemoryOs(storage: ReturnType<typeof createDOStorage>): void {
  const sql = storage.sql;
  sql.exec(`CREATE TABLE IF NOT EXISTS structured_facts (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT '', entity TEXT NOT NULL,
    relation TEXT NOT NULL, attribute TEXT NOT NULL, trust_score REAL NOT NULL DEFAULT 0.8,
    decay_rate REAL NOT NULL DEFAULT 0.01, last_used INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS episodic_log (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT '', text TEXT NOT NULL,
    importance REAL NOT NULL DEFAULT 0.5, promoted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT 0)`);
  sql.exec(
    `INSERT INTO structured_facts (id, entity, relation, attribute, trust_score, updated_at) VALUES (?,?,?,?,?,?)`,
    "f1", "premium tier", "price", "150 dollars", 0.9, 1000
  );
  sql.exec(
    `INSERT INTO episodic_log (id, text, importance, created_at) VALUES (?,?,?,?)`,
    "e1", "Goal: set up pricing\nOutcome: recorded the premium tier at 150", 0.3, 2000
  );
}

describe("GET /memory surfaces what the agent actually records", () => {
  it("returns Memory OS facts and episodic notes, not just the legacy key/value table", async () => {
    const { doInstance, storage } = makeDO();
    await getMemory(doInstance); // force ensureInit so agent_memory exists
    seedMemoryOs(storage);

    const body = await getMemory(doInstance);
    const values = body.entries.map((e: { value: unknown }) => String(e.value));

    expect(body.count).toBeGreaterThan(0);
    expect(values.some((v: string) => v.includes("150 dollars"))).toBe(true);
    expect(values.some((v: string) => v.includes("recorded the premium tier"))).toBe(true);
  });

  it("tags each entry with where it came from, so the two stores stay distinguishable", async () => {
    const { doInstance, storage } = makeDO();
    await getMemory(doInstance);
    seedMemoryOs(storage);

    const body = await getMemory(doInstance);
    const fact = body.entries.find((e: { category: string }) => e.category === "fact");
    const episodic = body.entries.find((e: { category: string }) => e.category === "episodic");

    expect(fact.source).toBe("memory-os");
    expect(fact.key).toBe("premium tier price");
    expect(fact.confidence).toBe(0.9);
    expect(episodic.source).toBe("memory-os");
  });

  it("a ?category filter still narrows the Memory OS rows", async () => {
    const { doInstance, storage } = makeDO();
    await getMemory(doInstance);
    seedMemoryOs(storage);

    const body = await getMemory(doInstance, "fact");
    expect(body.entries.every((e: { category: string }) => e.category === "fact")).toBe(true);
    expect(body.entries.length).toBe(1);
  });

  it("a DO that has never run an agent reports nothing rather than erroring on missing tables", async () => {
    const { doInstance } = makeDO();
    // No Memory OS tables exist at all — they are created lazily by memory-os.ts's own init.
    const body = await getMemory(doInstance);
    expect(body).toEqual({ entries: [], count: 0 });
  });

  it("still returns legacy agent_memory rows written through POST /memory", async () => {
    const { doInstance } = makeDO();
    await doInstance.fetch(
      new Request("http://agent-do/memory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "tone", category: "preference", value: "concise" }),
      })
    );

    const body = await getMemory(doInstance);
    const legacy = body.entries.find((e: { key: string }) => e.key === "tone");
    expect(legacy.value).toBe("concise");
    expect(legacy.source).toBe("legacy");
  });
});
