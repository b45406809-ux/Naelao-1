import { validateGoalDag, type GoalTask } from "./prebuilt/goal-planner.js";
import { createTaskMessage, visibleTaskMessages, type TaskMessage } from "./task-blackboard.js";

export interface GoalWorkerResult { id: string; ok: boolean; output?: unknown; error?: string; status?: string }
export type GoalTaskStatus = "pending" | "running" | "completed" | "failed" | "blocked" | "needs_review";
export interface GoalTaskState { status: GoalTaskStatus; workerId: string; result?: GoalWorkerResult }
export interface GoalEscalation { taskId: string; workerId: string; reason: "worker_failed" | "outcome_uncertain"; detail?: string; blockedTasks: string[]; nextAction: "investigate_failure" | "verify_effects_before_retry" }
export interface GoalFixerState { workerId: string; status: "running" | "completed" | "failed" | "needs_review"; result?: GoalWorkerResult }
export interface GoalDagJournal { tasks: Record<string, GoalTaskState>; messages?: TaskMessage[]; taskBlackboardEnabled?: boolean; escalations?: GoalEscalation[]; fixers?: Record<string, GoalFixerState>; fixerEnabled?: boolean }
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
  fixerEnabled?: boolean;
  fix?(task: GoalTask, workerId: string, failure: GoalWorkerResult): Promise<GoalWorkerResult>;
  acquireResources?(task: GoalTask, holderId: string): Promise<() => Promise<void>>;
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

/** An uncertain external effect always goes to review; never propose an automatic replay. */
function collectEscalations(tasks: GoalTask[], journal: GoalDagJournal): GoalEscalation[] {
  return tasks.flatMap(task => {
    const state = journal.tasks[task.id]!;
    if (state.status !== "failed" && state.status !== "needs_review") return [];
    const affected = new Set([task.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const candidate of tasks) if (!affected.has(candidate.id) && candidate.dependencies?.some(id => affected.has(id))) { affected.add(candidate.id); changed = true; }
    }
    const error = typeof state.result?.error === "string" ? state.result.error.slice(0, 1000) : undefined;
    return [{ taskId: task.id, workerId: state.workerId, reason: state.status === "failed" ? "worker_failed" as const : "outcome_uncertain" as const,
      ...(error ? { detail: error } : {}), blockedTasks: tasks.filter(candidate => candidate.id !== task.id && affected.has(candidate.id)).map(candidate => candidate.id),
      nextAction: state.status === "failed" ? "investigate_failure" as const : "verify_effects_before_retry" as const }];
  });
}

/** Persist before dispatch. A lost acknowledgement must never trigger blind mutation replay. */
export async function executeGoalDag(tasks: GoalTask[], host: GoalDagHost): Promise<GoalDagJournal> {
  validateGoalDag(tasks);
  if (!Number.isSafeInteger(host.concurrency) || host.concurrency < 1 || host.concurrency > 4) throw new Error("invalid_goal_concurrency");
  const loaded = await host.load();
  const journal: GoalDagJournal = loaded ?? { taskBlackboardEnabled: host.taskBlackboardEnabled === true, fixerEnabled: host.fixerEnabled === true, tasks: Object.fromEntries(tasks.map(task => [task.id, { status: "pending" as const, workerId: host.workerId(task.id) }])) };
  // Worker completions can checkpoint concurrently. Serialize immutable snapshots so a slow
  // earlier write cannot replace a newer journal with stale task states.
  let saveTail: Promise<void> = Promise.resolve();
  const save = (): Promise<void> => {
    const snapshot = structuredClone(journal);
    saveTail = saveTail.then(() => host.save(snapshot));
    return saveTail;
  };
  // Existing journals created during the initial rollout may already contain messages.
  if (loaded && journal.taskBlackboardEnabled === undefined) journal.taskBlackboardEnabled = Array.isArray(journal.messages);
  if (tasks.some(task => !journal.tasks[task.id]) || Object.keys(journal.tasks).length !== tasks.length) throw new Error("goal_journal_mismatch");
  for (const task of tasks) {
    const state = journal.tasks[task.id]!;
    if (state.status === "running") {
      const result = await host.recover(state.workerId);
      state.status = result ? (result.ok ? "completed" : result.status === "outcome_uncertain" ? "needs_review" : "failed") : "needs_review";
      if (result) state.result = result;
      await save();
    }
    recordCompletion(task, tasks, journal);
    if (journal.taskBlackboardEnabled && state.status === "completed") await save();
    await host.publish(task, state);
  }
  const inFlight = new Map<string, Promise<{ id: string; error?: unknown }>>();
  const activeResources = new Set<string>();
  for (;;) {
    const pending = tasks.filter(task => journal.tasks[task.id]!.status === "pending");
    for (const task of pending) {
      if ((task.dependencies ?? []).some(id => ["failed", "blocked", "needs_review"].includes(journal.tasks[id]!.status))) {
        journal.tasks[task.id]!.status = "blocked";
        await save();
        await host.publish(task, journal.tasks[task.id]!);
      }
    }
    const ready = pending.filter(task => journal.tasks[task.id]!.status === "pending" && (task.dependencies ?? []).every(id => journal.tasks[id]!.status === "completed"));
    if (!ready.length && inFlight.size === 0) {
      if (journal.fixerEnabled && host.fix) {
        for (const task of tasks) {
          const state = journal.tasks[task.id]!;
          if (state.status !== "failed" || !state.result || task.file_paths.length === 0) continue;
          const fixers = journal.fixers ??= {};
          let fixer = fixers[task.id];
          if (fixer?.status === "running") {
            const recovered = await host.recover(fixer.workerId);
            fixer.status = recovered ? (recovered.ok ? "completed" : recovered.status === "outcome_uncertain" ? "needs_review" : "failed") : "needs_review";
            if (recovered) fixer.result = recovered;
            await save();
          }
          if (fixer) continue;
          fixer = fixers[task.id] = { workerId: `${state.workerId}:fix`, status: "running" };
          await save();
          try {
            const result = await host.fix(task, fixer.workerId, state.result);
            fixer.result = result;
            fixer.status = result.ok ? "completed" : result.status === "awaiting_planner_input" || result.status === "awaiting_human_input" || result.status === "outcome_uncertain" ? "needs_review" : "failed";
          } catch {
            const recovered = await host.recover(fixer.workerId);
            fixer.status = recovered ? (recovered.ok ? "completed" : recovered.status === "outcome_uncertain" ? "needs_review" : "failed") : "needs_review";
            if (recovered) fixer.result = recovered;
          }
          await save();
        }
      }
      journal.escalations = collectEscalations(tasks, journal);
      await save();
      return journal;
    }
    // Claim and persist each available slot before starting its external worker effects.
    const slots = Math.max(0, host.concurrency - inFlight.size);
    const dispatch: GoalTask[] = [];
    const claimedResources = new Set(activeResources);
    for (const task of ready) {
      if (dispatch.length >= slots) break;
      const resources = task.resource_keys ?? [];
      if (resources.some(key => claimedResources.has(key))) continue;
      dispatch.push(task);
      for (const key of resources) claimedResources.add(key);
    }
    for (const task of dispatch) {
      journal.tasks[task.id]!.status = "running";
      for (const key of task.resource_keys ?? []) activeResources.add(key);
    }
    if (dispatch.length) await save();
    for (const task of dispatch) {
      const execution = (async () => {
      const state = journal.tasks[task.id]!;
      await host.publish(task, state);
      let result: GoalWorkerResult;
      let release: (() => Promise<void>) | undefined;
      try {
        release = await host.acquireResources?.(task, state.workerId) ?? (async () => {});
      }
      catch (error) {
        // Admission failed before the external worker was launched, so this outcome is known.
        state.result = { id: state.workerId, ok: false, error: String(error).slice(0, 1000) };
        state.status = "failed";
        recordCompletion(task, tasks, journal);
        await save();
        await host.publish(task, state);
        return;
      }
      try {
        try { result = await host.launch(task, state.workerId, dependencyHandoffs(task, journal)); }
        finally { await release(); }
      } catch (error) {
        // Transport failure may mean a committed worker response was lost.
        const recovered = await host.recover(state.workerId);
        if (!recovered) {
          state.status = "needs_review";
          await save();
          await host.publish(task, state);
          return;
        }
        result = recovered;
      }
      state.result = result;
      state.status = result.ok ? "completed" : result.status === "awaiting_planner_input" || result.status === "awaiting_human_input" || result.status === "outcome_uncertain" ? "needs_review" : "failed";
      recordCompletion(task, tasks, journal);
      await save();
      await host.publish(task, state);
      })().then(() => ({ id: task.id }), error => ({ id: task.id, error }));
      inFlight.set(task.id, execution);
    }
    if (inFlight.size) {
      const finished = await Promise.race(inFlight.values());
      inFlight.delete(finished.id);
      const finishedTask = tasks.find(task => task.id === finished.id);
      for (const key of finishedTask?.resource_keys ?? []) activeResources.delete(key);
      if (finished.error !== undefined) {
        const remaining = await Promise.all(inFlight.values());
        for (const item of remaining) inFlight.delete(item.id);
        throw finished.error;
      }
    }
  }
}
