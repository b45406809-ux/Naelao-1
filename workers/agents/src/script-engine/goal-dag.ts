import { MAX_GOAL_TASKS, taskCommunicationRecipients, validateGoalDag, type GoalTask } from "./prebuilt/goal-planner.js";
import { createTaskMessage, visibleTaskMessages, type TaskMessage } from "./task-blackboard.js";
import { evaluateGoalEvidence, type GoalEvidence, type GoalEvidenceCheck } from "./goal-evidence.js";
import { fingerprintGoalExpansionProposal, prepareGoalExpansion, readGoalExpansionProposal } from "./goal-expansion.js";

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
export interface GoalTaskState { status: GoalTaskStatus; workerId: string; dispatchId?: string; result?: GoalWorkerResult; runtime?: GoalTaskRuntimeState; verification?: { outcome: "passed" | "failed" | "uncertain"; reason: string }; decisionReviewReason?: string; shadowVerification?: { outcome: "failed" | "uncertain"; reason: string } }
export interface GoalEscalation { taskId: string; workerId: string; reason: "worker_failed" | "outcome_uncertain" | "verification_failed" | "verification_uncertain"; detail?: string; blockedTasks: string[]; nextAction: "investigate_failure" | "verify_effects_before_retry" | "review_verification" }
export interface GoalFixerState { workerId: string; status: "running" | "completed" | "failed" | "needs_review"; result?: GoalWorkerResult }
export interface GoalExpansionReceipt { proposalId: string; taskIds: string[]; status: "admitted" | "rejected"; reason?: string }
export interface GoalRoutingAdjustment {
  fromConcurrency: number | null;
  toConcurrency: number;
  reason: "initial_probe" | "verified_progress" | "failure_or_review" | "frontier_narrowed";
  at: number;
  taskId?: string;
  taskOutcome?: "completed" | "failed" | "needs_review";
  verificationOutcome?: "passed" | "failed" | "uncertain" | "not_required" | "unavailable";
}
export interface GoalDagJournal { tasks: Record<string, GoalTaskState>; taskDefinitions?: GoalTask[]; expansionReceipts?: Record<string, GoalExpansionReceipt>; messages?: TaskMessage[]; taskBlackboardEnabled?: boolean; escalations?: GoalEscalation[]; fixers?: Record<string, GoalFixerState>; fixerEnabled?: boolean; maxFixersPerGoal?: number; verificationRequired?: boolean; routing?: { mode: "single_worker" | "sequential" | "parallel"; taskCount: number; selectedConcurrency: number; hostConcurrencyCeiling: number; policy?: "progressive-v1"; adjustmentReason?: "initial_probe" | "verified_progress" | "failure_or_review" | "frontier_narrowed"; adjustments?: GoalRoutingAdjustment[] } }
export const MAX_GOAL_ROUTING_ADJUSTMENTS = 32;
/** Automatic repair is an opt-in, host-budgeted path with a hard kernel ceiling. */
export const MAX_GOAL_FIXERS_PER_RUN = 2;
/** Dependency results are untrusted data, scoped to an explicitly declared edge. */
export interface GoalHandoff { taskId: string; workerId: string; output: string; truncated: boolean }
export interface GoalDagHost {
  load(): Promise<GoalDagJournal | undefined>;
  save(journal: GoalDagJournal): Promise<void>;
  /** Atomically persist the running task states and their dispatch outbox intents. */
  commitDispatches?(journal: GoalDagJournal, dispatches: readonly { task: GoalTask; workerId: string; dispatchId: string }[]): Promise<void>;
  launch(task: GoalTask, workerId: string, handoffs: GoalHandoff[]): Promise<GoalWorkerResult>;
  dispatch?(task: GoalTask, workerId: string, handoffs: GoalHandoff[], dispatchId: string): Promise<{ result?: GoalWorkerResult; acknowledged: boolean; reason?: string }>;
  recover(workerId: string): Promise<GoalWorkerResult | undefined>;
  publish(task: GoalTask, state: GoalTaskState): Promise<void>;
  /** Recheck active decision identity/revision and its workspace pin before dispatch or reuse. */
  validateTaskDecisions?(task: GoalTask): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Dynamic expansion is host-gated and remains disabled unless both the feature flag and these callbacks are present. */
  dynamicExpansionEnabled?: boolean;
  remainingTaskBudgetTokens?(task: GoalTask, workerId: string): Promise<number>;
  admitExpansion?(input: { proposalId: string; parent: GoalTask; tasks: GoalTask[]; allTasks: GoalTask[] }): Promise<{ ok: true } | { ok: false; reason: string }>;
  workerId(taskId: string): string;
  concurrency: number;
  /** Progressive worker admission stays disabled unless the rollout gate is explicitly enabled. */
  adaptiveConcurrency?: boolean;
  taskBlackboardEnabled?: boolean;
  fixerEnabled?: boolean;
  maxFixersPerGoal?: number;
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

/**
 * Pick the smallest useful topology from the already-authorized task graph. The host ceiling
 * remains the hard maximum. Independent work starts with one worker and ramps up on successful
 * progress; failures/review contract future admission. A chain always remains sequential.
 * This does not create tasks or grant capabilities.
 */
function selectGoalRouting(tasks: GoalTask[], hostConcurrency: number, adaptiveConcurrency: boolean): NonNullable<GoalDagJournal["routing"]> {
  const ancestors = new Map<string, Set<string>>();
  const byId = new Map(tasks.map(task => [task.id, task]));
  const collect = (id: string): Set<string> => {
    const cached = ancestors.get(id);
    if (cached) return cached;
    const result = new Set<string>();
    for (const dependency of byId.get(id)?.dependencies ?? []) {
      result.add(dependency);
      for (const ancestor of collect(dependency)) result.add(ancestor);
    }
    ancestors.set(id, result);
    return result;
  };
  for (const task of tasks) collect(task.id);
  let independentPair = false;
  for (let i = 0; i < tasks.length && !independentPair; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const left = tasks[i]!, right = tasks[j]!;
      if (!ancestors.get(left.id)!.has(right.id) && !ancestors.get(right.id)!.has(left.id)) {
        independentPair = true;
        break;
      }
    }
  }
  const mode = tasks.length === 1 ? "single_worker" : independentPair ? "parallel" : "sequential";
  return {
    mode,
    taskCount: tasks.length,
    selectedConcurrency: adaptiveConcurrency ? 1 : mode === "parallel" ? Math.min(hostConcurrency, tasks.length) : 1,
    hostConcurrencyCeiling: hostConcurrency,
    ...(adaptiveConcurrency ? { policy: "progressive-v1" as const,
      ...(mode === "parallel" ? { adjustmentReason: "initial_probe" as const,
        adjustments: [{ fromConcurrency: null, toConcurrency: 1, reason: "initial_probe" as const, at: Date.now() }] } : {}) } : {}),
  };
}

function recordRoutingAdjustment(
  routing: NonNullable<GoalDagJournal["routing"]>,
  adjustment: GoalRoutingAdjustment,
): void {
  const adjustments = routing.adjustments ??= [];
  adjustments.push(adjustment);
  if (adjustments.length > MAX_GOAL_ROUTING_ADJUSTMENTS) adjustments.splice(0, adjustments.length - MAX_GOAL_ROUTING_ADJUSTMENTS);
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
  const recipients = taskCommunicationRecipients(task.id, tasks).map(recipientId => journal.tasks[recipientId]!.workerId);
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
  const hostFixerLimit = host.maxFixersPerGoal ?? 1;
  if (!Number.isSafeInteger(hostFixerLimit) || hostFixerLimit < 0 || hostFixerLimit > MAX_GOAL_FIXERS_PER_RUN) throw new Error("invalid_goal_fixer_limit");
  const loaded = await host.load();
  if (loaded?.taskDefinitions !== undefined) {
    if (!Array.isArray(loaded.taskDefinitions) || loaded.taskDefinitions.length > MAX_GOAL_TASKS) throw new Error("goal_journal_invalid_task_definitions");
    const persistedById = new Map(loaded.taskDefinitions.map(task => [task.id, task]));
    for (const task of tasks) {
      const persisted = persistedById.get(task.id);
      if (!persisted || persisted.title !== task.title || persisted.subtask_spec !== task.subtask_spec
        || persisted.assigned_role !== task.assigned_role || persisted.budget_tokens !== task.budget_tokens
        || JSON.stringify(persisted.file_paths) !== JSON.stringify(task.file_paths)
        || JSON.stringify(persisted.dependencies ?? []) !== JSON.stringify(task.dependencies ?? [])) throw new Error("goal_journal_mismatch");
    }
    const existingIds = new Set(tasks.map(task => task.id));
    tasks.push(...loaded.taskDefinitions.filter(task => !existingIds.has(task.id)).map(task => structuredClone(task)));
    validateGoalDag(tasks);
  }
  const persistedFixerLimit = loaded?.maxFixersPerGoal;
  if (persistedFixerLimit !== undefined && (!Number.isSafeInteger(persistedFixerLimit) || persistedFixerLimit < 0 || persistedFixerLimit > MAX_GOAL_FIXERS_PER_RUN)) throw new Error("goal_journal_invalid_fixer_limit");
  const effectiveFixerLimit = persistedFixerLimit === undefined ? hostFixerLimit : Math.min(persistedFixerLimit, hostFixerLimit);
  const journal: GoalDagJournal = loaded ?? { taskBlackboardEnabled: host.taskBlackboardEnabled === true, fixerEnabled: host.fixerEnabled === true, verificationRequired: host.verificationRequired === true, tasks: Object.fromEntries(tasks.map(task => [task.id, { status: "pending" as const, workerId: host.workerId(task.id) }])) };
  journal.taskDefinitions = structuredClone(tasks);
  journal.expansionReceipts ??= {};
  // Recompute on every resume so a stale persisted choice can never exceed current host policy.
  const routing = selectGoalRouting(tasks, host.concurrency, host.adaptiveConcurrency === true);
  if (host.adaptiveConcurrency === true && routing.mode === "parallel" && loaded?.routing?.policy === "progressive-v1"
      && Number.isSafeInteger(loaded.routing.selectedConcurrency) && loaded.routing.selectedConcurrency > 0) {
    routing.selectedConcurrency = Math.min(routing.hostConcurrencyCeiling, routing.taskCount, loaded.routing.selectedConcurrency);
    routing.adjustmentReason = loaded.routing.adjustmentReason ?? "initial_probe";
  }
  if (Array.isArray(loaded?.routing?.adjustments)) routing.adjustments = loaded.routing.adjustments.slice(-MAX_GOAL_ROUTING_ADJUSTMENTS);
  else if (loaded?.routing?.policy === "progressive-v1" && host.adaptiveConcurrency === true && routing.mode === "parallel") routing.adjustments = [];
  journal.routing = routing;
  await host.save(structuredClone(journal));
  // The feature flag is a live host kill switch. Persisted opt-in must not override a
  // stricter rollout setting when a graph resumes.
  journal.fixerEnabled = host.fixerEnabled === true;
  journal.maxFixersPerGoal = effectiveFixerLimit;
  // Worker completions can checkpoint concurrently. Serialize immutable snapshots so a slow
  // earlier write cannot replace a newer journal with stale task states.
  let saveTail: Promise<void> = Promise.resolve();
  const save = (): Promise<void> => {
    journal.taskDefinitions = structuredClone(tasks);
    const snapshot = structuredClone(journal);
    saveTail = saveTail.then(() => host.save(snapshot));
    return saveTail;
  };
  let lastCompletionEvidence: Pick<GoalRoutingAdjustment, "taskId" | "taskOutcome" | "verificationOutcome"> | undefined;
  const priorCompletion = tasks.flatMap(task => {
    const state = journal.tasks[task.id];
    return state?.runtime?.completedAt !== undefined && ["completed", "failed", "needs_review"].includes(state.status)
      ? [{ taskId: task.id, state, completedAt: state.runtime.completedAt }]
      : [];
  }).sort((left, right) => right.completedAt - left.completedAt)[0];
  if (priorCompletion) {
    lastCompletionEvidence = {
      taskId: priorCompletion.taskId,
      taskOutcome: priorCompletion.state.status as "completed" | "failed" | "needs_review",
      verificationOutcome: priorCompletion.state.verification?.outcome ?? (journal.verificationRequired ? "unavailable" : "not_required"),
    };
  }
  let expansionAdmissionTail: Promise<void> = Promise.resolve();
  const processGoalExpansion = async (parent: GoalTask, state: GoalTaskState): Promise<void> => {
    if (host.dynamicExpansionEnabled !== true || state.status !== "completed" || !state.result?.ok) return;
    const predecessor = expansionAdmissionTail;
    let release!: () => void;
    expansionAdmissionTail = new Promise<void>(resolve => { release = resolve; });
    await predecessor;
    try {
      const proposal = readGoalExpansionProposal(state.result.output);
      if (!proposal) return;
      const priorReceipt = journal.expansionReceipts?.[parent.id];
      if (priorReceipt) return;

      const reject = async (proposalId: string, reason: string): Promise<void> => {
        (journal.expansionReceipts ??= {})[parent.id] = {
          proposalId, taskIds: [], status: "rejected", reason: reason.slice(0, 240),
        };
        await save();
      };
      const proposalFingerprint = await fingerprintGoalExpansionProposal(parent.id, proposal);
      if (!host.remainingTaskBudgetTokens || !host.admitExpansion) {
        await reject(proposalFingerprint, "goal_expansion_host_admission_unavailable");
        return;
      }

      let prepared;
      try {
        const remainingBudgetTokens = await host.remainingTaskBudgetTokens(parent, state.workerId);
        prepared = await prepareGoalExpansion({ parent, existingTasks: tasks, proposedTasks: proposal, remainingBudgetTokens });
      } catch (error) {
        await reject(proposalFingerprint, error instanceof Error ? error.message : String(error));
        return;
      }
      const nextTasks = [...tasks, ...prepared.tasks];
      const admission = await host.admitExpansion({ proposalId: prepared.proposalId, parent, tasks: prepared.tasks, allTasks: nextTasks });
      if (!admission.ok) {
        await reject(prepared.proposalId, admission.reason);
        return;
      }
      for (const task of prepared.tasks) {
        if (journal.tasks[task.id]) throw new Error("goal_expansion_task_identity_conflict");
        journal.tasks[task.id] = { status: "pending", workerId: host.workerId(task.id) };
      }
      tasks.push(...prepared.tasks);
      (journal.expansionReceipts ??= {})[parent.id] = {
        proposalId: prepared.proposalId, taskIds: prepared.tasks.map(task => task.id), status: "admitted",
      };
      const priorRouting = journal.routing;
      journal.routing = selectGoalRouting(tasks, host.concurrency, host.adaptiveConcurrency === true);
      if (priorRouting?.adjustments) journal.routing.adjustments = priorRouting.adjustments.slice(-MAX_GOAL_ROUTING_ADJUSTMENTS);
      if (host.adaptiveConcurrency === true && priorRouting?.mode === "parallel" && journal.routing.mode === "parallel"
        && priorRouting.selectedConcurrency !== journal.routing.selectedConcurrency) {
        journal.routing.adjustmentReason = "initial_probe";
        recordRoutingAdjustment(journal.routing, {
          fromConcurrency: priorRouting.selectedConcurrency, toConcurrency: journal.routing.selectedConcurrency,
          reason: "initial_probe", at: Date.now(), taskId: parent.id, taskOutcome: "completed",
          verificationOutcome: state.verification?.outcome ?? (journal.verificationRequired ? "unavailable" : "not_required"),
        });
      }
      await save();
      for (const task of prepared.tasks) await host.publish(task, journal.tasks[task.id]!);
    } finally {
      release();
    }
  };
  const verifyResult = async (task: GoalTask, state: GoalTaskState): Promise<void> => {
    if (!state.result?.ok || (!host.verify && !journal.verificationRequired)) return;
    state.status = "verifying";
    await save();
    try {
      let assessment;
      if (journal.verificationRequired) {
        const evidence = await (host.collectEvidence?.(task, state.workerId) ?? Promise.resolve([]));
        let deterministic = evaluateGoalEvidence(task.acceptance_criteria ?? [], evidence);
        const pendingHumanReview = (task.human_review_required ?? []).some(criterion =>
          !evidence.some(item => item.criterion === criterion && item.source === "human_review" && item.outcome === "passed")
        );
        if (deterministic.outcome === "passed" && pendingHumanReview) {
          deterministic = { outcome: "uncertain", reason: "Required human review is pending" };
        }
        const modelAssessment = deterministic.outcome === "passed" && host.assessEvidence ? await host.assessEvidence(task, evidence, deterministic) : undefined;
        assessment = !modelAssessment
          ? deterministic
          : modelAssessment.outcome === "passed"
            ? modelAssessment
            : { outcome: "uncertain" as const, reason: "Decision assessment conflicts with deterministic evidence; review required." };
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
  const revalidateCompletedDecisionRefs = async (task: GoalTask, state: GoalTaskState): Promise<void> => {
    if (state.status !== "completed" || !task.decision_refs?.length) return;
    let validation: { ok: true } | { ok: false; reason: string };
    try { validation = await host.validateTaskDecisions?.(task) ?? { ok: false, reason: "decision_validation_unavailable" }; }
    catch { validation = { ok: false, reason: "decision_validation_unavailable" }; }
    if (!validation.ok) {
      state.status = "needs_review";
      state.decisionReviewReason = validation.reason.slice(0, 240);
      await save();
    }
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
    if ((state.status === "pending" || state.status === "completed") && task.decision_refs?.length) {
      let validation: { ok: true } | { ok: false; reason: string };
      try { validation = await host.validateTaskDecisions?.(task) ?? { ok: false, reason: "decision_validation_unavailable" }; }
      catch { validation = { ok: false, reason: "decision_validation_unavailable" }; }
      if (!validation.ok) {
        state.status = "needs_review";
        state.decisionReviewReason = validation.reason.slice(0, 240);
        await save();
      }
    }
    if (state.status === "completed" && state.result?.ok && !state.verification && (host.verify || journal.verificationRequired)) await verifyResult(task, state);
    if (state.status === "completed") await observeResult(task, state);
    await revalidateCompletedDecisionRefs(task, state);
    if (state.status === "completed") await processGoalExpansion(task, state);
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
    const ready = pending.filter(task => journal.tasks[task.id]!.status === "pending"
      && (task.dependencies ?? []).every(id => journal.tasks[id]!.status === "completed")
      // A host-selected peer edge is a message-availability barrier, not a success
      // dependency: the recipient wakes after the sender reaches any terminal state.
      && (!journal.taskBlackboardEnabled || tasks.filter(sender => sender.communication_recipients?.includes(task.id))
        .every(sender => !["pending", "running", "verifying"].includes(journal.tasks[sender.id]!.status))));
    if (host.adaptiveConcurrency === true && ready.length > 0 && journal.routing.mode === "parallel" && journal.routing.selectedConcurrency > ready.length) {
      const fromConcurrency = journal.routing.selectedConcurrency;
      journal.routing.selectedConcurrency = ready.length;
      journal.routing.adjustmentReason = "frontier_narrowed";
      recordRoutingAdjustment(journal.routing, {
        fromConcurrency, toConcurrency: ready.length, reason: "frontier_narrowed", at: Date.now(),
        ...(lastCompletionEvidence ?? {}),
      });
      await save();
    }
    for (const task of ready) {
      if (!task.decision_refs?.length) continue;
      let validation: { ok: true } | { ok: false; reason: string };
      try { validation = await host.validateTaskDecisions?.(task) ?? { ok: false, reason: "decision_validation_unavailable" }; }
      catch { validation = { ok: false, reason: "decision_validation_unavailable" }; }
      if (!validation.ok) {
        const state = journal.tasks[task.id]!;
        state.status = "needs_review";
        state.decisionReviewReason = validation.reason.slice(0, 240);
        await save();
        await host.publish(task, state);
      }
    }
    if (!ready.length && inFlight.size === 0) {
      const fixers = journal.fixers ??= {};
      // Always reconcile an already-running fixer, even if the feature flag was switched
      // off during an interruption. Recovery observes the existing attempt; it never starts
      // a replacement. Unknown outcomes are held for review.
      for (const task of tasks) {
        const fixer = fixers[task.id];
        if (fixer?.status !== "running") continue;
        let recovered: GoalWorkerResult | undefined;
        try { recovered = await host.recover(fixer.workerId); } catch { /* fail closed below */ }
        fixer.status = recovered
          ? recovered.ok ? "completed" : ["outcome_uncertain", "awaiting_planner_input", "awaiting_human_input"].includes(recovered.status ?? "") ? "needs_review" : "failed"
          : "needs_review";
        if (recovered) fixer.result = recovered;
        await save();
      }
      if (journal.fixerEnabled && host.fix) {
        for (const task of tasks) {
          const state = journal.tasks[task.id]!;
          if (state.status !== "failed" || !state.result || state.result.ok || task.file_paths.length === 0) continue;
          let fixer = fixers[task.id];
          if (fixer) continue;
          if (Object.keys(fixers).length >= effectiveFixerLimit) continue;
          fixer = fixers[task.id] = { workerId: `${state.workerId}:fix`, status: "running" };
          await save();
          try {
            const result = await host.fix(task, fixer.workerId, state.result);
            fixer.result = result;
            fixer.status = result.ok ? "completed" : result.status === "awaiting_planner_input" || result.status === "awaiting_human_input" || result.status === "outcome_uncertain" ? "needs_review" : "failed";
          } catch {
            let recovered: GoalWorkerResult | undefined;
            try { recovered = await host.recover(fixer.workerId); } catch { /* fail closed below */ }
            fixer.status = recovered
              ? recovered.ok ? "completed" : ["outcome_uncertain", "awaiting_planner_input", "awaiting_human_input"].includes(recovered.status ?? "") ? "needs_review" : "failed"
              : "needs_review";
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
    const slots = Math.max(0, journal.routing.selectedConcurrency - inFlight.size);
    const dispatch: GoalTask[] = [];
    const claimedResources = new Set(activeResources);
    for (const task of ready) {
      if (dispatch.length >= slots) break;
      if (journal.tasks[task.id]!.status !== "pending") continue;
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
      if (task.decision_refs?.length) {
        let validation: { ok: true } | { ok: false; reason: string };
        try { validation = await host.validateTaskDecisions?.(task) ?? { ok: false, reason: "decision_validation_unavailable" }; }
        catch { validation = { ok: false, reason: "decision_validation_unavailable" }; }
        if (!validation.ok) {
          state.status = "needs_review";
          state.decisionReviewReason = validation.reason.slice(0, 240);
          await save();
          await host.publish(task, state);
          return;
        }
      }
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
            if (!receipt.acknowledged && receipt.reason) {
              state.status = "needs_review";
              state.decisionReviewReason = receipt.reason.slice(0, 240);
              await save();
              await host.publish(task, state);
              return;
            }
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
      if (result.ok && task.decision_refs?.length) {
        let validation: { ok: true } | { ok: false; reason: string };
        try { validation = await host.validateTaskDecisions?.(task) ?? { ok: false, reason: "decision_validation_unavailable" }; }
        catch { validation = { ok: false, reason: "decision_validation_unavailable" }; }
        if (!validation.ok) {
          state.status = "needs_review";
          state.decisionReviewReason = validation.reason.slice(0, 240);
        }
      }
      if (result.ok && state.status === "completed") await verifyResult(task, state);
      if (state.status === "completed") await observeResult(task, state);
      await revalidateCompletedDecisionRefs(task, state);
      if (state.status === "completed") await processGoalExpansion(task, state);
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
      const finishedState = journal.tasks[finished.id];
      if (finishedState && ["completed", "failed", "needs_review"].includes(finishedState.status)) {
        lastCompletionEvidence = {
          taskId: finished.id,
          taskOutcome: finishedState.status as "completed" | "failed" | "needs_review",
          verificationOutcome: finishedState.verification?.outcome ?? (journal.verificationRequired ? "unavailable" : "not_required"),
        };
      }
      if (host.adaptiveConcurrency === true && journal.routing.mode === "parallel" && finishedState) {
        const fromConcurrency = journal.routing.selectedConcurrency;
        let reason: GoalRoutingAdjustment["reason"] | undefined;
        if (finishedState.status === "completed" && finishedState.result?.ok
            && (!journal.verificationRequired || finishedState.verification?.outcome === "passed")) {
          journal.routing.selectedConcurrency = Math.min(journal.routing.hostConcurrencyCeiling, journal.routing.taskCount, journal.routing.selectedConcurrency + 1);
          journal.routing.adjustmentReason = "verified_progress";
          reason = "verified_progress";
        } else if (["failed", "needs_review"].includes(finishedState.status)) {
          journal.routing.selectedConcurrency = Math.max(1, Math.min(journal.routing.selectedConcurrency - 1,
            Math.floor(journal.routing.selectedConcurrency / 2)));
          journal.routing.adjustmentReason = "failure_or_review";
          reason = "failure_or_review";
        }
        if (reason && journal.routing.selectedConcurrency !== fromConcurrency) {
          recordRoutingAdjustment(journal.routing, {
            fromConcurrency, toConcurrency: journal.routing.selectedConcurrency, reason, at: Date.now(),
            taskId: finished.id,
            taskOutcome: finishedState.status as "completed" | "failed" | "needs_review",
            verificationOutcome: finishedState.verification?.outcome ?? (journal.verificationRequired ? "unavailable" : "not_required"),
          });
        }
        await save();
      }
      if (finished.error !== undefined) {
        const remaining = await Promise.all(inFlight.values());
        for (const item of remaining) inFlight.delete(item.id);
        throw finished.error;
      }
    }
  }
}
