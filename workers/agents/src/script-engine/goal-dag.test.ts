import { describe, expect, it, vi } from "vitest";
import { executeGoalDag, type GoalDagHost, type GoalDagJournal } from "./goal-dag.js";
import { COORDINATION_PATTERNS, goalPlanner, validateGoalDag, type GoalTask } from "./prebuilt/goal-planner.js";
import { MAX_SUB_AGENT_BUDGET_TOKENS } from "./sub-agent-output.js";
const task = (id: string, dependencies: string[] = []): GoalTask => ({ id, dependencies, title: id, subtask_spec: `do ${id}`, assigned_role: "schema-validator", file_paths: [`src/${id}.ts`], budget_tokens: 1800 });
function fixture(initial?: GoalDagJournal) {
  let saved = initial;
  const host: GoalDagHost = { concurrency: 4, workerId: id => `worker:${id}`,
    load: async () => saved && structuredClone(saved), save: async journal => { saved = structuredClone(journal); },
    publish: vi.fn(async () => undefined), recover: vi.fn(async () => undefined),
    launch: vi.fn(async (_task, id) => ({ id, ok: true })),
  };
  return { host, snapshot: () => saved! };
}
describe("durable goal DAG", () => {
  it("exposes versioned coordination patterns as advisory, valid task graphs", async () => {
    const result = await goalPlanner.operations["engine.coordination_patterns"]!({}, {} as never) as { advisory: boolean; patterns: unknown[] };
    expect(result.advisory).toBe(true);
    expect(result.patterns).toHaveLength(2);
    for (const pattern of COORDINATION_PATTERNS) {
      const graph = pattern.steps.map(step => ({ ...task(step.id), dependencies: [...step.depends_on] }));
      expect(() => validateGoalDag(graph)).not.toThrow();
    }
  });
  it("delivers only direct dependency results as bounded untrusted handoffs", async () => {
    const f = fixture();
    f.host.launch = vi.fn(async (t, id) => ({ id, ok: true, output: t.id === "a" ? "x".repeat(5000) : t.id }));
    await executeGoalDag([task("a"), task("other"), task("b", ["a"])], f.host);
    const call = f.host.launch.mock.calls.find(([t]) => t.id === "b")!;
    expect(call[2]).toHaveLength(1);
    expect(call[2][0]).toMatchObject({ taskId: "a", workerId: "worker:a", truncated: true });
    expect(call[2][0].output).toHaveLength(3000);
    expect(f.snapshot().messages).toHaveLength(1);
    expect(f.snapshot().messages?.[0]?.recipients).toEqual(["worker:b"]);
  });
  it("reconstructs dependency handoffs after journal recovery", async () => {
    const f = fixture({ tasks: { a: { status: "completed", workerId: "worker:a", result: { id: "worker:a", ok: true, output: "evidence" } }, b: { status: "pending", workerId: "worker:b" } } });
    await executeGoalDag([task("a"), task("b", ["a"])], f.host);
    expect(f.host.launch.mock.calls[0]?.[2]).toEqual([{ taskId: "a", workerId: "worker:a", output: '"evidence"', truncated: false }]);
  });
  it("dispatches prerequisites before dependents and replays completed tasks without workers", async () => {
    const f = fixture(); const tasks = [task("b", ["a"]), task("a")];
    await executeGoalDag(tasks, f.host);
    expect(f.host.launch.mock.calls.map(([t]) => t.id)).toEqual(["a", "b"]);
    const restart = fixture(f.snapshot());
    expect((await executeGoalDag(tasks, restart.host)).tasks.b?.status).toBe("completed");
    expect(restart.host.launch).not.toHaveBeenCalled();
  });
  it("keeps independent work bounded and blocks descendants of failed workers", async () => {
    const f = fixture(); let active = 0, maximum = 0;
    f.host.concurrency = 2;
    f.host.launch = vi.fn(async (t, id) => { active++; maximum = Math.max(maximum, active); await Promise.resolve(); active--; return { id, ok: t.id !== "bad" }; });
    const result = await executeGoalDag([task("bad"), task("a"), task("c"), task("blocked", ["bad"])], f.host);
    expect(maximum).toBe(2); expect(result.tasks.blocked?.status).toBe("blocked");
    expect(f.host.launch.mock.calls.map(([t]) => t.id)).not.toContain("blocked");
  });
  it("recovers a completed worker after a lost acknowledgement", async () => {
    const f = fixture({ tasks: { a: { status: "running", workerId: "worker:a" } } });
    f.host.recover = vi.fn(async id => ({ id, ok: true, output: "committed" }));
    expect((await executeGoalDag([task("a")], f.host)).tasks.a?.result?.output).toBe("committed");
    expect(f.host.launch).not.toHaveBeenCalled();
  });
  it("requires review for uncertain effects instead of blindly replaying mutations", async () => {
    const f = fixture({ tasks: { a: { status: "running", workerId: "worker:a" }, b: { status: "pending", workerId: "worker:b" } } });
    const result = await executeGoalDag([task("a"), task("b", ["a"])], f.host);
    expect(result.tasks.a?.status).toBe("needs_review"); expect(result.tasks.b?.status).toBe("blocked");
    expect(f.host.launch).not.toHaveBeenCalled();
  });
  it("checkpoints a wave before any worker effect and preserves it across storage failure", async () => {
    const f = fixture(); f.host.save = vi.fn(async () => { throw new Error("storage offline"); });
    await expect(executeGoalDag([task("a")], f.host)).rejects.toThrow("storage offline"); expect(f.host.launch).not.toHaveBeenCalled();
  });
  it("observes the whole wave before propagating a status-publication failure", async () => {
    const f = fixture(); let release!: () => void, settled = false;
    f.host.publish = vi.fn(async (task, state) => { if (task.id === "a" && state.status === "running") throw new Error("status unavailable"); });
    f.host.launch = vi.fn(async (_task, id) => { await new Promise<void>(resolve => { release = resolve; }); return { id, ok: true }; });
    const run = executeGoalDag([task("a"), task("b")], f.host);
    const observed = run.then(() => { settled = true; }, () => { settled = true; });
    await vi.waitFor(() => expect(f.host.launch).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false); release();
    await expect(run).rejects.toThrow("status unavailable"); await observed;
    expect(f.snapshot().tasks.b?.status).toBe("completed");
  });
  it("rejects cycles, unknown dependencies and invalid budgets while permitting arbitrary roles", () => {
    expect(() => validateGoalDag([task("a")])).not.toThrow();
    expect(() => validateGoalDag([task("a", ["b"]), task("b", ["a"])])).toThrow("cycle");
    expect(() => validateGoalDag([task("a", ["missing"])])).toThrow("dependency");
    for (const budget_tokens of [NaN, Infinity, 1.5, MAX_SUB_AGENT_BUDGET_TOKENS + 1, 0]) expect(() => validateGoalDag([{ ...task("a"), budget_tokens }])).toThrow("budget");
  });
});
