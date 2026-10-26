import { describe, expect, it, vi } from "vitest";
import { ExecutionPreDispatchError, ExecutionSessions, type SessionStorage } from "./execution-sessions.js";
function storage(): SessionStorage {
  const map = new Map<string, unknown>();
  let queue = Promise.resolve();
  return { transaction<T>(fn: Parameters<SessionStorage["transaction"]>[0]): Promise<T> {
    const operation = queue.then(() => fn({ get: async <V>(key: string) => structuredClone(map.get(key)) as V, put: async (key, value) => { map.set(key, structuredClone(value)); }, delete: async key => { map.delete(key); } }));
    queue = operation.then(() => undefined, () => undefined);
    return operation as Promise<T>;
  } };
}
const input = { sessionId: "build", actionId: "install", actorId: "owner", branch: "task/build", targetId: "machine", command: "npm install", owner: { tenantId: "tenant", spaceId: "space", projectId: "project", scope: "PROJECT_BOUND" as const } };
describe("durable execution sessions", () => {
  it("returns confirmed results across coordinator restarts without executing again", async () => {
    const state = storage(), dispatch = vi.fn(async () => ({ stdout: "ok" }));
    await new ExecutionSessions(state).execute(input, dispatch);
    expect(await new ExecutionSessions(state).execute(input, dispatch)).toEqual({ stdout: "ok" });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it("blocks switching machines or reusing action identifiers with a different command", async () => {
    const sessions = new ExecutionSessions(storage());
    await sessions.execute(input, async () => "ok");
    await expect(sessions.execute({ ...input, targetId: "other", actionId: "test" }, async () => "bad")).rejects.toThrow("target_conflict");
    await expect(sessions.execute({ ...input, command: "rm -rf /" }, async () => "bad")).rejects.toThrow("action_conflict");
  });
  it("blocks dependent commands and uncertain dispatch replay", async () => {
    const sessions = new ExecutionSessions(storage());
    const dispatch = vi.fn(async () => { throw new Error("response lost"); });
    await expect(sessions.execute(input, dispatch)).rejects.toThrow("response lost");
    await expect(sessions.execute(input, dispatch)).rejects.toThrow("reconciliation_required");
    await expect(sessions.execute({ ...input, actionId: "test" }, dispatch)).rejects.toThrow("busy_or_unreconciled");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it("aborts a reservation failure before dispatch so the same action can retry", async () => {
    const sessions = new ExecutionSessions(storage()), dispatch = vi.fn()
      .mockRejectedValueOnce(new ExecutionPreDispatchError("quota denied"))
      .mockResolvedValueOnce({ status: "sent", request_id: "request" });
    await expect(sessions.execute(input, dispatch)).rejects.toThrow("quota denied");
    expect(await sessions.execute(input, dispatch)).toMatchObject({ status: "sent" });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
  it("does not call an accepted tunnel submission completed", async () => {
    const sessions = new ExecutionSessions(storage()), dispatch = vi.fn(async () => ({ status: "sent", request_id: "request" }));
    await sessions.execute(input, dispatch);
    await expect(sessions.execute(input, dispatch)).rejects.toThrow("reconciliation_required");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it("isolates actors, project scopes and branches", async () => {
    const sessions = new ExecutionSessions(storage()), dispatch = vi.fn(async () => "ok");
    await sessions.execute(input, dispatch);
    await sessions.execute({ ...input, actorId: "another" }, dispatch);
    await sessions.execute({ ...input, branch: "other" }, dispatch);
    await sessions.execute({ ...input, owner: { ...input.owner, projectId: "another" } }, dispatch);
    expect(dispatch).toHaveBeenCalledTimes(4);
  });
  it("dispatches once under a burst of 100 duplicate submissions", async () => {
    const sessions = new ExecutionSessions(storage()), dispatch = vi.fn(async () => "ok");
    const results = await Promise.allSettled(Array.from({ length: 100 }, () => sessions.execute(input, dispatch)));
    expect(results.some(result => result.status === "fulfilled")).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it("retains bounded receipts for large output and requires restoration between managed runs", async () => {
    const sessions = new ExecutionSessions(storage());
    const result = await sessions.execute({ ...input, executionEpoch: "run-a" }, async () => ({ stdout: "x".repeat(200000) }));
    expect(result).toMatchObject({ output_truncated: true, status: "succeeded" });
    await expect(sessions.execute({ ...input, actionId: "next", executionEpoch: "run-b" }, async () => "bad")).rejects.toThrow("restore_required");
  });
  it("unblocks a session only after a host-confirmed terminal outcome", async () => {
    const sessions = new ExecutionSessions(storage());
    await sessions.execute(input, async () => ({ status: "sent", request_id: "request" }));
    await sessions.reconcile(input, async () => ({ terminal: false, result: { status: "running" } }));
    await expect(sessions.execute({ ...input, actionId: "next" }, async () => "bad")).rejects.toThrow("busy");
    await sessions.reconcile(input, async () => ({ terminal: true, result: { status: "succeeded" } }));
    expect(await sessions.execute({ ...input, actionId: "next" }, async () => "next")).toBe("next");
  });

});
