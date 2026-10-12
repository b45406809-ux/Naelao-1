import { validateGoalDag, type GoalTask } from "./prebuilt/goal-planner.js";

export interface GoalWorkerResult { id: string; ok: boolean; output?: unknown; error?: string }
export type GoalTaskStatus = "pending" | "running" | "completed" | "failed" | "blocked" | "needs_review";
export interface GoalTaskState { status: GoalTaskStatus; workerId: string; result?: GoalWorkerResult }
export interface GoalDagJournal { tasks: Record<string, GoalTaskState> }
export interface GoalDagHost {
  load(): Promise<GoalDagJournal | undefined>;
  save(journal: GoalDagJournal): Promise<void>;
  launch(task: GoalTask, workerId: string): Promise<GoalWorkerResult>;
  recover(workerId: string): Promise<GoalWorkerResult | undefined>;
  publish(task: GoalTask, state: GoalTaskState): Promise<void>;
  workerId(taskId: string): string;
  concurrency: number;
}

/** Persist before dispatch. A lost acknowledgement must never trigger blind mutation replay. */
export async function executeGoalDag(tasks: GoalTask[], host: GoalDagHost): Promise<GoalDagJournal> {
  validateGoalDag(tasks);
  if (!Number.isSafeInteger(host.concurrency) || host.concurrency < 1 || host.concurrency > 4) throw new Error("invalid_goal_concurrency");
  const journal: GoalDagJournal = await host.load() ?? { tasks: Object.fromEntries(tasks.map(task => [task.id, { status: "pending" as const, workerId: host.workerId(task.id) }])) };
  if (tasks.some(task => !journal.tasks[task.id]) || Object.keys(journal.tasks).length !== tasks.length) throw new Error("goal_journal_mismatch");
  for (const task of tasks) {
    const state = journal.tasks[task.id]!;
    if (state.status === "running") {
      const result = await host.recover(state.workerId);
      state.status = result ? (result.ok ? "completed" : "failed") : "needs_review";
      if (result) state.result = result;
      await host.save(journal);
    }
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
      try { result = await host.launch(task, state.workerId); }
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
      await host.save(journal);
      await host.publish(task, state);
    }));
    const failed = wave.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}
