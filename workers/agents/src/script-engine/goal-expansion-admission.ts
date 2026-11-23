import { taskCommunicationRecipients, type GoalTask } from "./prebuilt/goal-planner.js";

export interface GoalExpansionTransaction {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

export interface GoalExpansionAdmissionStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  transaction<T>(callback: (transaction: GoalExpansionTransaction) => Promise<T>): Promise<T>;
}

export interface GoalExpansionAdmissionInput {
  storage: GoalExpansionAdmissionStorage;
  goalHash: string;
  intentKey: string;
  proposalId: string;
  additions: GoalTask[];
  allTasks: GoalTask[];
  tenantId: string;
  spaceId: string;
  actorId: string | null;
  projectId: string | null;
  taskBlackboardEnabled: boolean;
  taskId(localId: string): string;
  persistTasks(tasks: GoalTask[]): Promise<void>;
}

type ExpansionIntent = { proposalId: string; tasksJson: string; status: "pending" | "admitted" };
type GoalActivityMetadata = { tenantId: string; spaceId: string; actorId: string | null; tasks: Array<Record<string, unknown>> };
type TaskBlackboardScope = {
  tenantId: string; spaceId: string; projectId: string | null; actorId: string;
  rootRunId: string; parentDoId: string; members: string[]; grants: Array<[string, string[]]>;
};

function assertMetadataScope(metadata: GoalActivityMetadata | undefined, input: GoalExpansionAdmissionInput): asserts metadata is GoalActivityMetadata {
  if (!metadata || metadata.tenantId !== input.tenantId || metadata.spaceId !== input.spaceId
    || metadata.actorId !== input.actorId || !Array.isArray(metadata.tasks)) throw new Error("goal_expansion_activity_scope_unavailable");
}

function assertBlackboardScope(scope: TaskBlackboardScope | undefined, input: GoalExpansionAdmissionInput): asserts scope is TaskBlackboardScope {
  if (!scope || !input.actorId || scope.actorId !== input.actorId || scope.tenantId !== input.tenantId || scope.spaceId !== input.spaceId
    || (scope.projectId ?? null) !== input.projectId || !Array.isArray(scope.members) || !Array.isArray(scope.grants)) {
    throw new Error("task_blackboard_scope_unavailable");
  }
}

function activityProjection(task: GoalTask, allTasks: GoalTask[]): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    dependencies: task.dependencies ?? [],
    communication_recipients: taskCommunicationRecipients(task.id, allTasks),
    assigned_role: task.assigned_role,
    budget_tokens: task.budget_tokens,
    acceptance_criteria: task.acceptance_criteria ?? [],
    decision_refs: task.decision_refs ?? [],
    ...(task.runtime_capability ? { runtime_capability: task.runtime_capability } : {}),
  };
}

/**
 * Persist the cross-DO portion of an admitted expansion. SpaceDO task creation uses stable IDs
 * and is replayed from a durable pending intent; local metadata, grants, and intent completion
 * commit together. This is deliberately a staged saga, not a distributed transaction.
 */
export async function persistGoalExpansionAdmission(input: GoalExpansionAdmissionInput): Promise<void> {
  const { storage, intentKey, proposalId, additions, allTasks } = input;
  const tasksJson = JSON.stringify(additions);
  const priorIntent = await storage.get<ExpansionIntent>(intentKey);
  if (priorIntent && (priorIntent.proposalId !== proposalId || priorIntent.tasksJson !== tasksJson)) {
    throw new Error("goal_expansion_identity_conflict");
  }
  if (priorIntent?.status === "admitted") return;

  const metadataKey = `goal-activity:metadata:${input.goalHash}`;
  const scopeKey = `task-blackboard:scope:${input.goalHash}`;
  // Check immutable local scope before making the remote write; repeat these checks in the
  // transaction below so a concurrent scope change cannot authorize a stale commit.
  assertMetadataScope(await storage.get<GoalActivityMetadata>(metadataKey), input);
  if (input.taskBlackboardEnabled && input.actorId) assertBlackboardScope(await storage.get<TaskBlackboardScope>(scopeKey), input);

  if (!priorIntent) await storage.put(intentKey, { proposalId, tasksJson, status: "pending" } satisfies ExpansionIntent);

  const projectedTasks = additions.map(task => ({
    ...task,
    id: input.taskId(task.id),
    dependencies: (task.dependencies ?? []).map(input.taskId),
    communication_recipients: taskCommunicationRecipients(task.id, allTasks).map(input.taskId),
  }));
  await input.persistTasks(projectedTasks);

  await storage.transaction(async tx => {
    const metadata = await tx.get<GoalActivityMetadata>(metadataKey);
    assertMetadataScope(metadata, input);
    const byId = new Map(metadata.tasks.map(item => [String(item.id), item]));
    for (const task of allTasks) {
      const projection = activityProjection(task, allTasks);
      const prior = byId.get(task.id);
      if (prior) {
        const { communication_recipients: _priorRecipients, ...priorIdentity } = prior;
        const { communication_recipients: _nextRecipients, ...nextIdentity } = projection;
        if (JSON.stringify(priorIdentity) !== JSON.stringify(nextIdentity)) throw new Error("goal_expansion_activity_identity_conflict");
      } else if (!additions.some(addition => addition.id === task.id)) {
        throw new Error("goal_expansion_activity_identity_conflict");
      }
      byId.set(task.id, projection);
    }
    await tx.put(metadataKey, { ...metadata, tasks: [...byId.values()] });

    if (input.taskBlackboardEnabled && input.actorId) {
      const scope = await tx.get<TaskBlackboardScope>(scopeKey);
      assertBlackboardScope(scope, input);
      await tx.put(scopeKey, {
        ...scope,
        members: allTasks.map(task => input.taskId(task.id)),
        grants: allTasks.map(task => [input.taskId(task.id), taskCommunicationRecipients(task.id, allTasks).map(input.taskId)] as [string, string[]]),
      });
    }
    await tx.put(intentKey, { proposalId, tasksJson, status: "admitted" } satisfies ExpansionIntent);
  });
}
