import { describe, expect, it, vi } from "vitest";
import { memory } from "./memory.js";

function context(userId: string | undefined) {
  const memoryStore = {
    remember: vi.fn(async () => ({ id: "own" })),
    recall: vi.fn(async () => []),
    forget: vi.fn(async () => undefined),
  };
  return { memoryStore, ctx: { env: { userId, memoryStore } } as never };
}

describe("memory user scope", () => {
  it.each([
    ["memory.remember", { text: "private note" }],
    ["memory.recall", { query: "private note" }],
    ["memory.forget", { id: "another-user-memory" }],
  ] as const)("does not allow a model supplied user_id to cross scopes for %s", async (operation, input) => {
    const f = context("user-a");
    await expect(memory.operations[operation]!(
      { ...input, user_id: "user-b" },
      f.ctx,
    )).rejects.toThrow("memory_scope_denied");
    expect(f.memoryStore.remember).not.toHaveBeenCalled();
    expect(f.memoryStore.recall).not.toHaveBeenCalled();
    expect(f.memoryStore.forget).not.toHaveBeenCalled();
  });

  it("uses the authenticated actor scope for a matching explicit user id", async () => {
    const f = context("user-a");
    await memory.operations["memory.recall"]!({ query: "own notes", user_id: "user-a" }, f.ctx);
    expect(f.memoryStore.recall).toHaveBeenCalledWith({ userId: "user-a", text: "own notes", limit: 5 });
  });

  it("does not let a run without an actor select a personal namespace", async () => {
    const f = context(undefined);
    await expect(memory.operations["memory.recall"]!({ query: "private", user_id: "user-a" }, f.ctx))
      .rejects.toThrow("memory_scope_denied");
    expect(f.memoryStore.recall).not.toHaveBeenCalled();
  });
});
