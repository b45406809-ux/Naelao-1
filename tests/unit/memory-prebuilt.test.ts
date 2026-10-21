import { describe, it, expect, vi } from "vitest";
import { memory } from "../../workers/agents/src/script-engine/prebuilt/memory.js";
import type { ScriptEngineEnv, MemoryStore } from "../../workers/agents/src/script-engine/types.js";

function ctxWith(memoryStore?: MemoryStore, userId?: string) {
  const env = {
    spaceId: "space1",
    agentId: "agent1",
    tenantId: "tenant1",
    scriptsBucket: {} as R2Bucket,
    ...(memoryStore ? { memoryStore } : {}),
    ...(userId ? { userId } : {}),
  } as ScriptEngineEnv;
  return { env, run: vi.fn() };
}

describe("memory prebuilt — the Hermes-pattern self-managed memory tool", () => {
  it("memory.remember defaults to the run's userId (no cross-user bleed by accident)", async () => {
    const remember = vi.fn().mockResolvedValue({ id: "m1" });
    const store: MemoryStore = { remember, recall: vi.fn(), forget: vi.fn() };
    const ctx = ctxWith(store, "alice");

    await memory.operations["memory.remember"]!({ text: "likes tea", entity: "alice", relation: "likes", attribute: "tea" }, ctx);
    expect(remember).toHaveBeenCalledWith(expect.objectContaining({ userId: "alice", entity: "alice", relation: "likes", attribute: "tea" }));
  });

  it("an explicit user_id in args overrides the run's userId (admin remembering on behalf of someone)", async () => {
    const remember = vi.fn().mockResolvedValue({ id: "m1" });
    const store: MemoryStore = { remember, recall: vi.fn(), forget: vi.fn() };
    const ctx = ctxWith(store, "alice");

    await memory.operations["memory.remember"]!({ text: "x", user_id: "bob" }, ctx);
    expect(remember).toHaveBeenCalledWith(expect.objectContaining({ userId: "bob" }));
  });

  it("memory.recall forwards the query and returns results", async () => {
    const recall = vi.fn().mockResolvedValue([{ id: "f1", layer: "structured_fact", text: "alice likes tea", score: 1 }]);
    const store: MemoryStore = { remember: vi.fn(), recall, forget: vi.fn() };
    const ctx = ctxWith(store, "alice");

    const result = await memory.operations["memory.recall"]!({ query: "tea" }, ctx);
    expect(recall).toHaveBeenCalledWith(expect.objectContaining({ userId: "alice", text: "tea" }));
    expect(result).toMatchObject({ results: [{ id: "f1", text: "alice likes tea" }] });
  });

  it("memory.forget deletes by id", async () => {
    const forget = vi.fn().mockResolvedValue(undefined);
    const store: MemoryStore = { remember: vi.fn(), recall: vi.fn(), forget };
    const ctx = ctxWith(store, "alice");

    const result = await memory.operations["memory.forget"]!({ id: "f1" }, ctx);
    expect(forget).toHaveBeenCalledWith("f1");
    expect(result).toEqual({ ok: true });
  });

  it("memory.remember requires text", async () => {
    const store: MemoryStore = { remember: vi.fn(), recall: vi.fn(), forget: vi.fn() };
    const ctx = ctxWith(store);
    await expect(memory.operations["memory.remember"]!({}, ctx)).rejects.toThrow(/text/);
  });

  it("degrades honestly with no memoryStore configured", async () => {
    const ctx = ctxWith(undefined);
    const result = await memory.operations["memory.recall"]!({ query: "x" }, ctx);
    expect(result).toMatchObject({ ok: false });
  });
});

// memory.compact — the same maintenance pass the shell UI's auto-compact HTTP route triggers,
// exposed as a tool a model can call mid-run instead of only ever being triggered client-side.
describe("memory.compact", () => {
  it("calls env.compactMemory and reports its result", async () => {
    const compactMemory = vi.fn().mockResolvedValue({ decayed: 3, promoted: 1 });
    const env = {
      spaceId: "space1", agentId: "agent1", tenantId: "tenant1", scriptsBucket: {} as R2Bucket,
      compactMemory,
    } as ScriptEngineEnv;
    const ctx = { env, run: vi.fn() };

    const result = await memory.operations["memory.compact"]!({}, ctx);

    expect(compactMemory).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, result: { decayed: 3, promoted: 1 } });
  });

  it("degrades honestly when the host hasn't wired compaction", async () => {
    const env = { spaceId: "space1", agentId: "agent1", tenantId: "tenant1", scriptsBucket: {} as R2Bucket } as ScriptEngineEnv;
    const ctx = { env, run: vi.fn() };

    const result = await memory.operations["memory.compact"]!({}, ctx);
    expect(result).toEqual({ ok: false, reason: "compaction not available in this environment" });
  });
});
