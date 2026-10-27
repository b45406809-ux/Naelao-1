import { validateGoalDag, type GoalTask } from "./prebuilt/goal-planner.js";
import { createTaskMessage, visibleTaskMessages, type TaskMessage } from "./task-blackboard.js";

export interface GoalWorkerResult { id: string; ok: boolean; output?: unknown; error?: string }
export type GoalTaskStatus = "pending" | "running" | "completed" | "failed" | "blocked" | "needs_review";
export interface GoalTaskState { status: GoalTaskStatus; workerId: string; result?: GoalWorkerResult }
export interface GoalDagJournal { tasks: Record<string, GoalTaskState>; messages?: TaskMessage[]; taskBlackboardEnabled?: boolean }
/** Dependency results are untrusted data, scoped to an explicitly declared edge. */
export interface GoalHandoff { taskId: string; workerId: string; output: string; truncated: boolean }
export interface GoalDagHost {
  load(): Promise<GoalDagJournal | undefined>;
  save(journal: GoalDagJournal): Promise<void>;
  launch(task: GoalTask, workerId: string, handoffs: GoalHandoff[]): Promise<GoalWorkerResult>;
  recover(workerId: string): Promise<GoalWorkerResult | undefined>;
  publish(task: GoalTask, state: GoalTaskState): Promise<void>;
  workerId(taskId: string): string;
  concurrency: number;
  taskBlackboardEnabled?: boolean;
}

function dependencyHandoffs(task: GoalTask, journal: GoalDagJournal): GoalHandoff[] {
  if (!journal.taskBlackboardEnabled) return (task.dependencies ?? []).map(taskId => {
    const state = journal.tasks[taskId]!;
    let output: string;
    try { output = JSON.stringify(state.result?.output ?? null) ?? "null"; }
    catch { output = '"[unavailable: non-serializable output]"'; }
    return { taskId, workerId: state.workerId, output: output.slice(0, 4000), truncated: output.length > 4000 };
  });
  const members = new Set(Object.values(journal.tasks).map(state => state.workerId));
  const actor = journal.tasks[task.id]!.workerId;
  const visible = visibleTaskMessages(journal.messages ?? [], actor, members);
  return (task.dependencies ?? []).map(taskId => {
    const state = journal.tasks[taskId]!;
    const message = visible.find(item => item.id === `completion:${taskId}` && item.sender === state.workerId);
    if (!message) throw new Error("goal_dependency_message_missing");
    const value = JSON.parse(message.text) as { output: string; truncated: boolean };
    return { taskId, workerId: state.workerId, ...value };
  });
}

function recordCompletion(task: GoalTask, tasks: GoalTask[], journal: GoalDagJournal): void {
  if (!journal.taskBlackboardEnabled) return;
  const state = journal.tasks[task.id]!;
  if (state.status !== "completed") return;
  const recipients = tasks.filter(candidate => candidate.dependencies?.includes(task.id)).map(candidate => journal.tasks[candidate.id]!.workerId);
  if (!recipients.length || (journal.messages ?? []).some(message => message.id === `completion:${task.id}`)) return;
  let serialized: string;
  try { serialized = JSON.stringify(state.result?.output ?? null) ?? "null"; }
  catch { serialized = '"[unavailable: non-serializable output]"'; }
  // Reserve room for JSON escaping and metadata under the message size limit.
  let output = serialized.slice(0, 3000);
  while (JSON.stringify({ output, truncated: serialized.length > output.length }).length > 4000) output = output.slice(0, -100);
  const text = JSON.stringify({ output, truncated: serialized.length > output.length });
  const members = new Set(Object.values(journal.tasks).map(item => item.workerId));
  (journal.messages ??= []).push(createTaskMessage({ id: `completion:${task.id}`, recipients, kind: "completion", text }, state.workerId, members, Date.now()));
}

/** Persist before dispatch. A lost acknowledgement must never trigger blind mutation replay. */
export async function executeGoalDag(tasks: GoalTask[], host: GoalDagHost): Promise<GoalDagJournal> {
  validateGoalDag(tasks);
  if (!Number.isSafeInteger(host.concurrency) || host.concurrency < 1 || host.concurrency > 4) throw new Error("invalid_goal_concurrency");
  const loaded = await host.load();
  const journal: GoalDagJournal = loaded ?? { taskBlackboardEnabled: host.taskBlackboardEnabled === true, tasks: Object.fromEntries(tasks.map(task => [task.id, { status: "pending" as const, workerId: host.workerId(task.id) }])) };
  // Existing journals created during the initial rollout may already contain messages.
  if (loaded && journal.taskBlackboardEnabled === undefined) journal.taskBlackboardEnabled = Array.isArray(journal.messages);
  if (tasks.some(task => !journal.tasks[task.id]) || Object.keys(journal.tasks).length !== tasks.length) throw new Error("goal_journal_mismatch");
  for (const task of tasks) {
    const state = journal.tasks[task.id]!;
    if (state.status === "running") {
      const result = await host.recover(state.workerId);
      state.status = result ? (result.ok ? "completed" : "failed") : "needs_review";
      if (result) state.result = result;
      await host.save(journal);
    }
    recordCompletion(task, tasks, journal);
    if (journal.taskBlackboardEnabled && state.status === "completed") await host.save(journal);
    await host.publish(task, state);
  }
  for (;;) {
    const pending = tasks.filter(task => journal.tasks[task.id]!.status === "pending");
    for (const task of pending) {
      if ((task.dependencies ?? []).some(id => ["failed", "blocked", "needs_review"].includes(journal.tasks[id]!.status))) {
        journal.tasks[task.id]!.status = "blocked";
        await host.save(journal);
        await host.publish(task, journal.tasks[task.id]!);
      }
    }
    const ready = pending.filter(task => journal.tasks[task.id]!.status === "pending" && (task.dependencies ?? []).every(id => journal.tasks[id]!.status === "completed")).slice(0, host.concurrency);
    if (!ready.length) return journal;
    // One checkpoint for the whole wave, before any external worker effects.
    for (const task of ready) journal.tasks[task.id]!.status = "running";
    await host.save(journal);
    const wave = await Promise.allSettled(ready.map(async task => {
      const state = journal.tasks[task.id]!;
      await host.publish(task, state);
      let result: GoalWorkerResult;
      try { result = await host.launch(task, state.workerId, dependencyHandoffs(task, journal)); }
      catch (error) {
        // Transport failure may mean a committed worker response was lost.
        const recovered = await host.recover(state.workerId);
        if (!recovered) {
          state.status = "needs_review";
          await host.save(journal);
          await host.publish(task, state);
          return;
        }
        result = recovered;
      }
      state.result = result;
      state.status = result.ok ? "completed" : "failed";
      recordCompletion(task, tasks, journal);
      await host.save(journal);
      await host.publish(task, state);
    }));
    const failed = wave.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}
