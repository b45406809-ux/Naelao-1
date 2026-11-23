import { describe, expect, it, vi } from "vitest";
import { prepareGoalExpansion } from "./goal-expansion.js";
import { persistGoalExpansionAdmission, type GoalExpansionAdmissionStorage, type GoalExpansionTransaction } from "./goal-expansion-admission.js";
import type { GoalTask } from "./prebuilt/goal-planner.js";

function storageFixture(initial: Array<[string, unknown]>) {
  let data = new Map(initial.map(([key, value]) => [key, structuredClone(value)]));
  let failNextTransaction = false;
  const storage: GoalExpansionAdmissionStorage = {
    get: async key => data.has(key) ? structuredClone(data.get(key)) : undefined,
    put: async (key, value) => { data.set(key, structuredClone(value)); },
    transaction: async callback => {
      if (failNextTransaction) {
        failNextTransaction = false;
        throw new Error("injected_agent_commit_failure");
      }
      const draft = new Map([...data].map(([key, value]) => [key, structuredClone(value)]));
      const tx: GoalExpansionTransaction = {
        get: async key => draft.has(key) ? structuredClone(draft.get(key)) : undefined,
        put: async (key, value) => { draft.set(key, structuredClone(value)); },
      };
      const result = await callback(tx);
      data = draft;
      return result;
    },
  };
  return { storage, read: (key: string) => data.get(key), failTransaction: () => { failNextTransaction = true; } };
}

describe("durable goal expansion admission", () => {
  it("replays stable SpaceDO task creation after the AgentDO transaction fails", async () => {
    const goalHash = "a".repeat(64);
    const intentKey = `goal-expansion-admission:${goalHash}:proposal-1`;
    const parent: GoalTask = {
      id: "root", title: "Root", subtask_spec: "Inspect the issue", assigned_role: "schema-validator",
      file_paths: ["src/a.ts"], dependencies: [], budget_tokens: 1_000,
    };
    const prepared = await prepareGoalExpansion({ parent, existingTasks: [parent], proposedTasks: [
      { id: "follow-up", title: "Follow up", subtask_spec: "Verify the finding", budget_tokens: 300 },
    ], remainingBudgetTokens: 500 });
    const allTasks = [parent, ...prepared.tasks];
    const taskId = (id: string) => `${goalHash}:${id}`;
    const metadataKey = `goal-activity:metadata:${goalHash}`;
    const scopeKey = `task-blackboard:scope:${goalHash}`;
    const initialMetadata = {
      tenantId: "tenant-a", spaceId: "space-a", actorId: "actor-a",
      tasks: [{ id: "root", title: "Root", dependencies: [], communication_recipients: [], assigned_role: "schema-validator", budget_tokens: 1_000, acceptance_criteria: [], decision_refs: [] }],
    };
    const initialScope = {
      tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", actorId: "actor-a",
      rootRunId: "run-a", parentDoId: "agent-a", members: [taskId("root")], grants: [[taskId("root"), []] as [string, string[]]],
    };
    const f = storageFixture([[metadataKey, initialMetadata], [scopeKey, initialScope]]);
    const remoteTasks = new Map<string, GoalTask>();
    const persistTasks = vi.fn(async (tasks: GoalTask[]) => {
      for (const task of tasks) {
        const prior = remoteTasks.get(task.id);
        if (prior && JSON.stringify(prior) !== JSON.stringify(task)) throw new Error("remote_task_identity_conflict");
        remoteTasks.set(task.id, structuredClone(task));
      }
    });
    const admit = () => persistGoalExpansionAdmission({
      storage: f.storage,
      goalHash,
      intentKey,
      proposalId: prepared.proposalId,
      additions: prepared.tasks,
      allTasks,
      tenantId: "tenant-a",
      spaceId: "space-a",
      actorId: "actor-a",
      projectId: "project-a",
      taskBlackboardEnabled: true,
      taskId,
      persistTasks,
    });

    f.failTransaction();
    await expect(admit()).rejects.toThrow("injected_agent_commit_failure");
    expect(remoteTasks.size).toBe(1);
    expect(f.read(intentKey)).toMatchObject({ proposalId: prepared.proposalId, status: "pending" });
    expect(f.read(metadataKey)).toEqual(initialMetadata);
    expect(f.read(scopeKey)).toEqual(initialScope);

    await expect(admit()).resolves.toBeUndefined();
    expect(persistTasks).toHaveBeenCalledTimes(2);
    expect(remoteTasks.size).toBe(1);
    expect(f.read(intentKey)).toMatchObject({ proposalId: prepared.proposalId, status: "admitted" });
    expect(f.read(metadataKey)).toMatchObject({
      tasks: expect.arrayContaining([
        expect.objectContaining({ id: "root", communication_recipients: [prepared.tasks[0]!.id] }),
        expect.objectContaining({ id: prepared.tasks[0]!.id, dependencies: ["root"] }),
      ]),
    });
    expect(f.read(scopeKey)).toMatchObject({
      members: [taskId("root"), taskId(prepared.tasks[0]!.id)],
      grants: [[taskId("root"), [taskId(prepared.tasks[0]!.id)]], [taskId(prepared.tasks[0]!.id), []]],
    });

    await admit();
    expect(persistTasks).toHaveBeenCalledTimes(2);
  });

  it("checks the actor-scoped local graph before creating remote tasks", async () => {
    const goalHash = "b".repeat(64);
    const parent: GoalTask = { id: "root", title: "Root", subtask_spec: "Inspect", assigned_role: "schema-validator", file_paths: [], dependencies: [], budget_tokens: 1_000 };
    const prepared = await prepareGoalExpansion({ parent, existingTasks: [parent], proposedTasks: [
      { id: "follow-up", title: "Follow up", subtask_spec: "Verify", budget_tokens: 100 },
    ], remainingBudgetTokens: 200 });
    const persistTasks = vi.fn(async () => undefined);
    const f = storageFixture([[`goal-activity:metadata:${goalHash}`, {
      tenantId: "tenant-other", spaceId: "space-a", actorId: "actor-a", tasks: [],
    }]]);

    await expect(persistGoalExpansionAdmission({
      storage: f.storage,
      goalHash,
      intentKey: `goal-expansion-admission:${goalHash}:${prepared.proposalId}`,
      proposalId: prepared.proposalId,
      additions: prepared.tasks,
      allTasks: [parent, ...prepared.tasks],
      tenantId: "tenant-a",
      spaceId: "space-a",
      actorId: "actor-a",
      projectId: null,
      taskBlackboardEnabled: false,
      taskId: id => `${goalHash}:${id}`,
      persistTasks,
    })).rejects.toThrow("goal_expansion_activity_scope_unavailable");
    expect(persistTasks).not.toHaveBeenCalled();
  });
});
