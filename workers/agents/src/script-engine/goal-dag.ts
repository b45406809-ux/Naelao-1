import { validateGoalDag, type GoalTask } from "./prebuilt/goal-planner.js";
import { createTaskMessage, visibleTaskMessages, type TaskMessage } from "./task-blackboard.js";
import { evaluateGoalEvidence, type GoalEvidence, type GoalEvidenceCheck } from "./goal-evidence.js";

export interface GoalWorkerResult { id: string; ok: boolean; output?: unknown; error?: string; status?: string }
export type GoalTaskStatus = "pending" | "running" | "verifying" | "completed" | "failed" | "blocked" | "needs_review";
export interface GoalTaskRuntimeState {
  status: "waiting" | "assigned" | "running" | "completed" | "failed";
  capability?: string;
  queuePosition?: number;
  queuedAt?: number;
  assignedAt?: number;
  startedAt?: number;
  completedAt?: number;
  queueWaitMs?: number;
  executionMs?: number;
}
export interface GoalTaskState { status: GoalTaskStatus; workerId: string; dispatchId?: string; result?: GoalWorkerResult; runtime?: GoalTaskRuntimeState; verification?: { outcome: "passed" | "failed" | "uncertain"; reason: string }; shadowVerification?: { outcome: "failed" | "uncertain"; reason: string } }
export interface GoalEscalation { taskId: string; workerId: string; reason: "worker_failed" | "outcome_uncertain" | "verification_failed" | "verification_uncertain"; detail?: string; blockedTasks: string[]; nextAction: "investigate_failure" | "verify_effects_before_retry" | "review_verification" }
export interface GoalFixerState { workerId: string; status: "running" | "completed" | "failed" | "needs_review"; result?: GoalWorkerResult }
export interface GoalDagJournal { tasks: Record<string, GoalTaskState>; messages?: TaskMessage[]; taskBlackboardEnabled?: boolean; escalations?: GoalEscalation[]; fixers?: Record<string, GoalFixerState>; fixerEnabled?: boolean; verificationRequired?: boolean }
/** Dependency results are untrusted data, scoped to an explicitly declared edge. */
export interface GoalHandoff { taskId: string; workerId: string; output: string; truncated: boolean }
export interface GoalDagHost {
  load(): Promise<GoalDagJournal | undefined>;
  save(journal: GoalDagJournal): Promise<void>;
  /** Atomically persist the running task states and their dispatch outbox intents. */
  commitDispatches?(journal: GoalDagJournal, dispatches: readonly { task: GoalTask; workerId: string; dispatchId: string }[]): Promise<void>;
  launch(task: GoalTask, workerId: string, handoffs: GoalHandoff[]): Promise<GoalWorkerResult>;
  dispatch?(task: GoalTask, workerId: string, handoffs: GoalHandoff[], dispatchId: string): Promise<{ result?: GoalWorkerResult; acknowledged: boolean }>;
  recover(workerId: string): Promise<GoalWorkerResult | undefined>;
  publish(task: GoalTask, state: GoalTaskState): Promise<void>;
  workerId(taskId: string): string;
  concurrency: number;
  taskBlackboardEnabled?: boolean;
  fixerEnabled?: boolean;
  verificationRequired?: boolean;
  collectEvidence?(task: GoalTask, workerId: string): Promise<GoalEvidence[]>;
  assessEvidence?(task: GoalTask, evidence: readonly GoalEvidence[], deterministic: { outcome: "passed" | "failed" | "uncertain"; reason: string }): Promise<{ outcome: "passed" | "failed" | "uncertain"; reason: string }>;
  evidenceChecks?: Readonly<Record<string, readonly GoalEvidenceCheck[]>>;
  verify?(task: GoalTask, result: GoalWorkerResult): Promise<{ outcome: "passed" | "failed" | "uncertain"; reason: string }>;
  observeVerification?(task: GoalTask, result: GoalWorkerResult): Promise<{ outcome: "failed" | "uncertain"; reason: string }>;
  fix?(task: GoalTask, workerId: string, failure: GoalWorkerResult): Promise<GoalWorkerResult>;
  acquireResources?(task: GoalTask, holderId: string, onRuntimeState?: (state: GoalTaskRuntimeState) => Promise<void>): Promise<() => Promise<void>>;
  recordRuntimeMetrics?(event: { capability?: string; status: "completed" | "failed"; queueWaitMs?: number; executionMs?: number }): void;
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
    const error = state.verification?.reason ?? (typeof state.result?.error === "string" ? state.result.error.slice(0, 1000) : undefined);
    const verificationReason = state.verification?.outcome === "failed" ? "verification_failed" as const : state.verification?.outcome === "uncertain" ? "verification_uncertain" as const : undefined;
    return [{ taskId: task.id, workerId: state.workerId, reason: verificationReason ?? (state.status === "failed" ? "worker_failed" as const : "outcome_uncertain" as const),
      ...(error ? { detail: error } : {}), blockedTasks: tasks.filter(candidate => candidate.id !== task.id && affected.has(candidate.id)).map(candidate => candidate.id),
      nextAction: verificationReason ? "review_verification" as const : state.status === "failed" ? "investigate_failure" as const : "verify_effects_before_retry" as const }];
  });
}

/** Persist before dispatch. A lost acknowledgement must never trigger blind mutation replay. */
export async function executeGoalDag(tasks: GoalTask[], host: GoalDagHost): Promise<GoalDagJournal> {
  validateGoalDag(tasks);
  if (!Number.isSafeInteger(host.concurrency) || host.concurrency < 1 || host.concurrency > 4) throw new Error("invalid_goal_concurrency");
  const loaded = await host.load();
  const journal: GoalDagJournal = loaded ?? { taskBlackboardEnabled: host.taskBlackboardEnabled === true, fixerEnabled: host.fixerEnabled === true, verificationRequired: host.verificationRequired === true, tasks: Object.fromEntries(tasks.map(task => [task.id, { status: "pending" as const, workerId: host.workerId(task.id) }])) };
  // Worker completions can checkpoint concurrently. Serialize immutable snapshots so a slow
  // earlier write cannot replace a newer journal with stale task states.
  let saveTail: Promise<void> = Promise.resolve();
  const save = (): Promise<void> => {
    const snapshot = structuredClone(journal);
    saveTail = saveTail.then(() => host.save(snapshot));
    return saveTail;
  };
  const verifyResult = async (task: GoalTask, state: GoalTaskState): Promise<void> => {
    if (!state.result?.ok || (!host.verify && !journal.verificationRequired)) return;
    state.status = "verifying";
    await save();
    try {
      let assessment;
      if (journal.verificationRequired) {
        const evidence = await (host.collectEvidence?.(task, state.workerId) ?? Promise.resolve([]));
        const deterministic = evaluateGoalEvidence(task.acceptance_criteria ?? [], evidence);
        const modelAssessment = deterministic.outcome === "passed" && host.assessEvidence ? await host.assessEvidence(task, evidence, deterministic) : undefined;
        assessment = modelAssessment && modelAssessment.outcome !== "passed" ? { outcome: "uncertain" as const, reason: "Decision assessment conflicts with deterministic evidence; review required." } : deterministic;
      } else assessment = await host.verify!(task, state.result);
      if (!assessment || !["passed", "failed", "uncertain"].includes(assessment.outcome) || typeof assessment.reason !== "string" || !assessment.reason.trim()) throw new Error("invalid_verification_result");
      state.verification = { outcome: assessment.outcome, reason: assessment.reason.slice(0, 2000) };
      state.status = assessment.outcome === "passed" ? "completed" : assessment.outcome === "failed" ? "failed" : "needs_review";
    } catch {
      state.verification = { outcome: "uncertain", reason: "Verification unavailable or invalid" };
      state.status = "needs_review";
    }
    await save();
  };
  const observeResult = async (task: GoalTask, state: GoalTaskState): Promise<void> => {
    if (!state.result?.ok || !host.observeVerification || state.shadowVerification) return;
    try {
      const observation = await host.observeVerification(task, state.result);
      if (!observation || !["failed", "uncertain"].includes(observation.outcome) || typeof observation.reason !== "string" || !observation.reason.trim()) throw new Error("invalid_shadow_verification");
      state.shadowVerification = { outcome: observation.outcome, reason: observation.reason.slice(0, 2000) };
    } catch {
      state.shadowVerification = { outcome: "uncertain", reason: "Shadow verification unavailable or invalid" };
    }
    await save();
  };
  // Existing journals created during the initial rollout may already contain messages.
  if (loaded && journal.taskBlackboardEnabled === undefined) journal.taskBlackboardEnabled = Array.isArray(journal.messages);
  if (tasks.some(task => !journal.tasks[task.id]) || Object.keys(journal.tasks).length !== tasks.length) throw new Error("goal_journal_mismatch");
  for (const task of tasks) {
    const state = journal.tasks[task.id]!;
    if (state.status === "running") {
      const result = await host.recover(state.workerId);
      state.status = result ? (result.ok ? "completed" : result.status === "outcome_uncertain" || result.status === "awaiting_planner_input" || result.status === "awaiting_human_input" ? "needs_review" : "failed") : "needs_review";
      if (result) state.result = result;
      if (state.runtime && result) {
        const completedAt = Date.now();
        const executionMs = state.runtime.startedAt === undefined ? undefined : Math.max(0, completedAt - state.runtime.startedAt);
        state.runtime = { ...state.runtime, status: result.ok ? "completed" : "failed", completedAt, ...(executionMs !== undefined ? { executionMs } : {}) };
        host.recordRuntimeMetrics?.({ ...(state.runtime.capability ? { capability: state.runtime.capability } : {}), status: result.ok ? "completed" : "failed", ...(state.runtime.queueWaitMs !== undefined ? { queueWaitMs: state.runtime.queueWaitMs } : {}), ...(executionMs !== undefined ? { executionMs } : {}) });
      }
      await save();
    }
    if (state.status === "verifying") { state.status = "needs_review"; state.verification = { outcome: "uncertain", reason: "Verification interrupted" }; await save(); }
    else if (state.status === "completed" && state.result?.ok && !state.verification && (host.verify || journal.verificationRequired)) await verifyResult(task, state);
    if (state.status === "completed") await observeResult(task, state);
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
          if (state.status !== "failed" || !state.result || state.result.ok || task.file_paths.length === 0) continue;
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
      journal.tasks[task.id]!.dispatchId ??= `dispatch:${journal.tasks[task.id]!.workerId}:${(journal.tasks[task.id]!.dispatchId?.split(":").at(-1) ?? "1")}`;
      journal.tasks[task.id]!.status = "running";
      for (const key of task.resource_keys ?? []) activeResources.add(key);
    }
    if (dispatch.length) {
      const snapshot = structuredClone(journal);
      if (host.commitDispatches) {
        saveTail = saveTail.then(() => host.commitDispatches!(snapshot, dispatch.map(task => ({ task, workerId: journal.tasks[task.id]!.workerId, dispatchId: journal.tasks[task.id]!.dispatchId! }))));
        await saveTail;
      } else await save();
    }
    for (const task of dispatch) {
      const execution = (async () => {
      const state = journal.tasks[task.id]!;
      await host.publish(task, state);
      let result: GoalWorkerResult;
      let release: (() => Promise<void>) | undefined;
      try {
        release = await host.acquireResources?.(task, state.workerId, async runtime => {
          state.runtime = runtime;
          await save();
        }) ?? (async () => {});
        if (state.runtime) {
          const { queuePosition: _queuePosition, ...runtime } = state.runtime;
          state.runtime = { ...runtime, status: "running", startedAt: Date.now() };
          await save();
        }
      }
      catch (error) {
        // Admission failed before the external worker was launched, so this outcome is known.
        state.result = { id: state.workerId, ok: false, error: String(error).slice(0, 1000) };
        state.status = "failed";
        if (state.runtime) state.runtime = { ...state.runtime, status: "failed" };
        recordCompletion(task, tasks, journal);
        await save();
        await host.publish(task, state);
        return;
      }
      try {
        try {
          const handoffs = dependencyHandoffs(task, journal);
          if (host.dispatch) {
            const receipt = await host.dispatch(task, state.workerId, handoffs, state.dispatchId!);
            if (!receipt.acknowledged) throw new Error("goal_dispatch_acknowledgement_uncertain");
            if (!receipt.result) throw new Error("goal_dispatch_result_unavailable");
            result = receipt.result;
          } else result = await host.launch(task, state.workerId, handoffs);
        }
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
      if (result.ok) await verifyResult(task, state);
      if (state.status === "completed") await observeResult(task, state);
      if (state.runtime) {
        const completedAt = Date.now();
        const executionMs = state.runtime.startedAt === undefined ? undefined : Math.max(0, completedAt - state.runtime.startedAt);
        state.runtime = { ...state.runtime, status: result.ok ? "completed" : "failed", completedAt, ...(executionMs !== undefined ? { executionMs } : {}) };
        host.recordRuntimeMetrics?.({ ...(state.runtime.capability ? { capability: state.runtime.capability } : {}), status: result.ok ? "completed" : "failed", ...(state.runtime.queueWaitMs !== undefined ? { queueWaitMs: state.runtime.queueWaitMs } : {}), ...(executionMs !== undefined ? { executionMs } : {}) });
      }
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
