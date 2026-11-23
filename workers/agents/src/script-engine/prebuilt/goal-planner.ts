import type { UniversalAgentRole } from "@naelao/agent-sdk";
import type { PrebuiltScript } from "./index.js";
import { DEFAULT_SUB_AGENT_BUDGET_TOKENS, MAX_SUB_AGENT_BUDGET_TOKENS } from "../sub-agent-output.js";
import { childFanout } from "../delegation-contract.js";

/** Advisory patterns: the planner still supplies task specifications and authorized capabilities. */
export const COORDINATION_PATTERNS = [
  { id: "implementation-and-review", version: 1, description: "Implement a change, then independently verify and review it.", steps: [
    { id: "implement", depends_on: [], outcome: "Implementation and changed artifact references" },
    { id: "verify", depends_on: ["implement"], outcome: "Verification results and evidence" },
    { id: "review", depends_on: ["implement"], outcome: "Review findings and evidence" },
  ] },
  { id: "research-and-synthesis", version: 1, description: "Gather evidence, then synthesize a source-linked answer.", steps: [
    { id: "research", depends_on: [], outcome: "Findings and source references" },
    { id: "synthesize", depends_on: ["research"], outcome: "Synthesis with source references and limitations" },
  ] },
] as const;

export interface GoalTask {
  id: string;
  title: string;
  subtask_spec: string;
  /** Planner-supplied acceptance criteria; untrusted descriptions, never authority. */
  acceptance_criteria?: string[];
  /** Bounded host operations; never accepts shell or free-form code. */
  evidence_checks?: Array<{ criterion: string; operation: string }>;
  /** Existing Project Journal decisions this task depends on; references are host-revalidated. */
  decision_refs?: Array<{ id: string; revision: number }>;
  /** Stricter gate: these criteria cannot pass until the host supplies a human-review receipt. */
  human_review_required?: string[];
  assigned_role: UniversalAgentRole;
  context_affinity?: "shared" | "isolated";
  agent_id?: string;
  planner?: boolean;
  /** Explicit alternatives; a verified completion can make other members unnecessary. */
  redundancy_group?: string;
  /** Scheduling hint for a shared mutable environment; host controls remain authoritative. */
  resource_keys?: string[];
  /** System One recommendation from the installed, host-approved runtime catalogue. */
  runtime_capability?: string;
  runtime_confidence?: number;
  /** Host-generated exact lock associated with the approved runtime; planner input is discarded. */
  runtime_resource_key?: string;
  /** Bounded queue priority; host caps and ages it to prevent starvation. */
  priority?: number;
  /** Host-owned depth marker for the opt-in, one-level goal expansion path. */
  expansion_depth?: number;
  file_paths: string[];
  dependencies?: string[];
  /** Host-selected, bounded blackboard peers; planner input for this field is discarded. */
  communication_recipients?: string[];
  budget_tokens: number;
}

export const MAX_GOAL_TASKS = 12;
export const MAX_GOAL_PLANNER_CHILDREN = childFanout(1, true);

/** Directed host grant set: DAG successors plus Decisions-selected peer recipients. */
export function taskCommunicationRecipients(taskId: string, tasks: readonly GoalTask[]): string[] {
  const task = tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`unknown goal task '${taskId}'`);
  return [...new Set([
    ...tasks.filter((candidate) => candidate.dependencies?.includes(taskId)).map((candidate) => candidate.id),
    ...(task.communication_recipients ?? []),
  ])];
}

export function validateGoalDag(tasks: GoalTask[]): void {
  if (tasks.length > MAX_GOAL_TASKS) throw new Error(`goal plan exceeds ${MAX_GOAL_TASKS} tasks`);
  if (!tasks.length) throw new Error("goal plan must contain at least one task");
  const ids = new Set(tasks.map((task) => task.id));
  if (ids.size !== tasks.length) throw new Error("goal task ids must be unique");
  for (const task of tasks) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(task.id) || !task.title || !task.subtask_spec || !Array.isArray(task.file_paths)) throw new Error(`invalid goal task '${task.id}'`);
    if (typeof task.assigned_role !== "string" || !task.assigned_role.trim() || task.assigned_role.length > 128) throw new Error(`task '${task.id}' has an invalid assigned_role`);
    if (task.acceptance_criteria !== undefined && (!Array.isArray(task.acceptance_criteria) || task.acceptance_criteria.length < 1 || task.acceptance_criteria.length > 8 || task.acceptance_criteria.some(item => typeof item !== "string" || !item.trim() || item.length > 500))) throw new Error(`task '${task.id}' has invalid acceptance_criteria`);
    if (task.evidence_checks !== undefined && (!Array.isArray(task.evidence_checks) || task.evidence_checks.length > 8 || task.evidence_checks.some(check => !check || typeof check.criterion !== "string" || !task.acceptance_criteria?.includes(check.criterion) || typeof check.operation !== "string" || !/^(artifact\.sha256|workspace\.exists|workspace\.sha256):[^\s]{1,256}$/.test(check.operation)) || new Set(task.evidence_checks.map(check => check.criterion)).size !== task.evidence_checks.length)) throw new Error(`task '${task.id}' has invalid evidence_checks`);
    if (task.human_review_required !== undefined && (!Array.isArray(task.human_review_required) || task.human_review_required.length > 8 || task.human_review_required.some(criterion => typeof criterion !== "string" || !task.acceptance_criteria?.includes(criterion)) || new Set(task.human_review_required).size !== task.human_review_required.length)) throw new Error(`task '${task.id}' has invalid human_review_required`);
    if (task.decision_refs !== undefined && (!Array.isArray(task.decision_refs) || task.decision_refs.length > 4 || task.decision_refs.some(ref =>
      !ref || typeof ref.id !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(ref.id) || !Number.isSafeInteger(ref.revision) || ref.revision < 1
    ) || new Set(task.decision_refs.map(ref => ref.id)).size !== task.decision_refs.length)) throw new Error(`task '${task.id}' has invalid decision_refs`);
    if (task.evidence_checks !== undefined && task.evidence_checks.some(check => !task.file_paths.includes(check.operation.split(":")[1] ?? ""))) throw new Error(`task '${task.id}' evidence check paths must be declared`);
    if (!Number.isSafeInteger(task.budget_tokens) || task.budget_tokens < 1 || task.budget_tokens > MAX_SUB_AGENT_BUDGET_TOKENS) throw new Error(`task '${task.id}' budget_tokens must be within 1..${MAX_SUB_AGENT_BUDGET_TOKENS}`);
    if (task.resource_keys !== undefined && (!Array.isArray(task.resource_keys) || task.resource_keys.length > 8 || task.resource_keys.some(key => typeof key !== "string" || !/^[a-z][a-z0-9._:-]{0,95}$/.test(key)) || new Set(task.resource_keys).size !== task.resource_keys.length)) throw new Error(`task '${task.id}' has invalid resource_keys`);
    if (task.runtime_capability !== undefined && (typeof task.runtime_capability !== "string" || !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(task.runtime_capability))) throw new Error(`task '${task.id}' has an invalid runtime_capability`);
    if (task.runtime_confidence !== undefined && (!Number.isFinite(task.runtime_confidence) || task.runtime_confidence < 0 || task.runtime_confidence > 1)) throw new Error(`task '${task.id}' has an invalid runtime_confidence`);
    if (task.runtime_resource_key !== undefined && (typeof task.runtime_resource_key !== "string" || !/^runtime\.[a-z-]+\.[a-f0-9]{40}$/.test(task.runtime_resource_key))) throw new Error(`task '${task.id}' has an invalid runtime_resource_key`);
    if (task.priority !== undefined && (!Number.isSafeInteger(task.priority) || task.priority < -10 || task.priority > 10)) throw new Error(`task '${task.id}' priority must be within -10..10`);
    if (task.redundancy_group !== undefined && (typeof task.redundancy_group !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(task.redundancy_group))) throw new Error(`task '${task.id}' has an invalid redundancy_group`);
    if (task.expansion_depth !== undefined && (!Number.isSafeInteger(task.expansion_depth) || task.expansion_depth < 0 || task.expansion_depth > 1)) throw new Error(`task '${task.id}' has an invalid expansion_depth`);
    for (const dependency of task.dependencies ?? []) if (!ids.has(dependency) || dependency === task.id) throw new Error(`task '${task.id}' has invalid dependency '${dependency}'`);
    if (task.communication_recipients !== undefined && (!Array.isArray(task.communication_recipients) || task.communication_recipients.length > 8 || task.communication_recipients.some(id => typeof id !== "string" || !ids.has(id) || id === task.id) || new Set(task.communication_recipients).size !== task.communication_recipients.length)) throw new Error(`task '${task.id}' has invalid communication_recipients`);
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error("goal plan contains a dependency cycle");
    if (visited.has(id)) return;
    visiting.add(id); for (const dep of byId.get(id)?.dependencies ?? []) visit(dep);
    visiting.delete(id); visited.add(id);
  };
  for (const id of ids) visit(id);
  const ancestry = new Map<string, Set<string>>();
  const ancestors = (id: string): Set<string> => {
    const cached = ancestry.get(id);
    if (cached) return cached;
    const result = new Set<string>();
    for (const dependency of byId.get(id)?.dependencies ?? []) {
      result.add(dependency);
      for (const ancestor of ancestors(dependency)) result.add(ancestor);
    }
    ancestry.set(id, result);
    return result;
  };
  for (const id of ids) ancestors(id);
  const redundancyGroups = new Map<string, GoalTask[]>();
  for (const task of tasks) if (task.redundancy_group) {
    const group = redundancyGroups.get(task.redundancy_group) ?? [];
    group.push(task);
    redundancyGroups.set(task.redundancy_group, group);
  }
  for (const [groupId, members] of redundancyGroups) {
    if (members.length < 2) throw new Error(`redundancy group '${groupId}' must contain at least two tasks`);
    for (let left = 0; left < members.length; left++) for (let right = left + 1; right < members.length; right++) {
      const a = members[left]!, b = members[right]!;
      if (ancestry.get(a.id)!.has(b.id) || ancestry.get(b.id)!.has(a.id)) throw new Error(`redundancy group '${groupId}' cannot contain dependent tasks`);
    }
  }
  const communicationVisiting = new Set<string>(), communicationVisited = new Set<string>();
  const visitCommunication = (id: string): void => {
    if (communicationVisiting.has(id)) throw new Error("goal plan contains a communication cycle");
    if (communicationVisited.has(id)) return;
    communicationVisiting.add(id);
    for (const recipient of byId.get(id)?.communication_recipients ?? []) visitCommunication(recipient);
    communicationVisiting.delete(id); communicationVisited.add(id);
  };
  for (const id of ids) visitCommunication(id);
}

function normalizeTaskBudget(value: unknown, taskId: string, planBudget: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_SUB_AGENT_BUDGET_TOKENS) {
    throw new Error(`task '${taskId}' has an invalid budget_tokens`);
  }
  return Math.min(planBudget, value);
}

function parseTasks(value: unknown, planBudget: number, nestedBudgetPool: boolean): GoalTask[] {
  if (!Array.isArray(value)) throw new Error("tasks must be an array");
  if (!Number.isSafeInteger(planBudget) || planBudget < 1 || planBudget > MAX_SUB_AGENT_BUDGET_TOKENS) throw new Error("goal_plan_budget_invalid");
  const records = value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid goal task");
    return raw as Record<string, unknown>;
  });
  const unspecifiedCount = nestedBudgetPool ? records.filter(task => task.budget_tokens === undefined).length : 0;
  const explicitBudgetTotal = nestedBudgetPool ? records.reduce((sum, task, index) => task.budget_tokens === undefined
    ? sum
    : sum + normalizeTaskBudget(task.budget_tokens, String(task.id ?? index + 1), planBudget), 0) : 0;
  if (nestedBudgetPool && explicitBudgetTotal > planBudget) throw new Error("goal_plan_budget_exceeded");
  const remainingNestedBudget = nestedBudgetPool ? planBudget - explicitBudgetTotal : 0;
  if (nestedBudgetPool && unspecifiedCount > remainingNestedBudget) throw new Error("goal_plan_budget_exhausted");
  const defaultNestedBudget = nestedBudgetPool && unspecifiedCount > 0
    ? Math.floor(remainingNestedBudget / unspecifiedCount) : planBudget;
  const tasks = records.map((task, index) => {
    if (task.redundancy_group !== undefined && typeof task.redundancy_group !== "string") {
      throw new Error(`task '${String(task.id ?? index + 1)}' has an invalid redundancy_group`);
    }
    const filePaths = Array.isArray(task.file_paths) ? task.file_paths.map(String) : [];
    const contextAffinity: GoalTask["context_affinity"] = task.context_affinity === "shared" || task.context_affinity === "isolated"
      ? task.context_affinity
      : filePaths.length > 0 ? "shared" : "isolated";
    const taskId = String(task.id ?? `task-${index + 1}`);
    const budgetTokens = normalizeTaskBudget(task.budget_tokens === undefined ? defaultNestedBudget : task.budget_tokens, taskId, planBudget);
    const subtaskSpec = String(task.subtask_spec ?? "");
    const declaredResources = Array.isArray(task.resource_keys) ? task.resource_keys.map(String) : undefined;
    return {
      id: taskId, title: String(task.title ?? ""),
      subtask_spec: subtaskSpec,
      ...(task.acceptance_criteria !== undefined ? { acceptance_criteria: task.acceptance_criteria as string[] } : {}),
      ...(task.evidence_checks !== undefined ? { evidence_checks: task.evidence_checks as Array<{ criterion: string; operation: string }> } : {}),
      ...(task.decision_refs !== undefined ? { decision_refs: task.decision_refs as Array<{ id: string; revision: number }> } : {}),
      ...(task.human_review_required !== undefined ? { human_review_required: task.human_review_required as string[] } : {}),
      assigned_role: String(task.assigned_role ?? "worker") as UniversalAgentRole,
      context_affinity: contextAffinity,
      ...(typeof task.agent_id === "string" ? { agent_id: task.agent_id } : {}),
      ...(task.planner === true ? { planner: true } : {}),
      ...(typeof task.redundancy_group === "string" ? { redundancy_group: task.redundancy_group } : {}),
      ...(declaredResources ? { resource_keys: declaredResources } : {}),
      ...(typeof task.priority === "number" ? { priority: task.priority } : {}),
      file_paths: filePaths,
      dependencies: Array.isArray(task.dependencies) ? task.dependencies.map(String) : [],
      // Peer grants are selected by the host Decisions service after planning. Ignore
      // planner/model-supplied recipients so a plan cannot grant its own access.
      budget_tokens: budgetTokens,
    };
  });
  if (nestedBudgetPool && tasks.reduce((sum, task) => sum + task.budget_tokens, 0) > planBudget) throw new Error("goal_plan_budget_exceeded");
  validateGoalDag(tasks); return tasks;
}

export const goalPlanner: PrebuiltScript = {
  name: "goal-planner", domain: "orchestration", requires_tier: 2,
  description: "Persist a frontier-planned task DAG and concurrently dispatch isolated edge workers.",
  paramHints: { "engine.coordination_patterns": "List advisory, versioned coordination patterns. Instantiate tasks only when useful; patterns do not grant capabilities.", "engine.plan_and_delegate_goal": "objective and tasks required. Each task: id, title, subtask_spec (give the worker a detailed outcome and constraints; let it plan with its assigned capability subset), assigned_role, acceptance_criteria? (1-8 concrete outcomes, each at most 500 characters), evidence_checks? (bounded host operations only), decision_refs? (up to four {id,revision} references to currently active Project Journal decisions; host revalidates before dispatch and resume; stale references hold work for review), human_review_required? (list any acceptance criteria that require a human judgment or sign-off; these cannot pass until the host provides an approved human-review receipt), priority? (-10..10 queue preference; host applies aging), context_affinity? (shared|isolated; inferred from file_paths when omitted), resource_keys? (up to 8 shared mutable environment keys; tasks sharing one are scheduled serially within this DAG, while unrelated ready work can proceed; advisory scheduling only), redundancy_group? (explicitly mark at least two independent tasks as interchangeable investigations; the first completed-and-verified result makes the remaining group members redundant and eligible for cancellation), agent_id? (own configured worker), planner? (request a depth-2 subplanner; at most four planner children per root graph, with no deeper planner children), file_paths, dependencies?, budget_tokens up to your subscription plan's worker limit. Omit budget_tokens to use that limit. A nested planner's child-task budgets share the parent task's assigned worker-token ceiling; omitted budgets split the remaining pool across those tasks. The host Decisions service may grant bounded one-way peer blackboard sharing; the planner cannot choose recipients, and sharing never creates execution dependencies or grants authority. The host selects a subset of the worker's configured related tools and skills; selection never grants unconfigured tools. Keep dependent order intact and independent work parallel where useful. Worker model is selected by runtime policy, never by a task-supplied model id." },
  operations: {
    async "engine.coordination_patterns"() {
      return { patterns: structuredClone(COORDINATION_PATTERNS), advisory: true };
    },
    async "engine.plan_and_delegate_goal"(args, ctx) {
      const objective = String(args.objective ?? "").trim();
      if (!objective) throw new Error("objective is required");
      const planBudget = ctx.env.workerTokenBudget ?? DEFAULT_SUB_AGENT_BUDGET_TOKENS;
      const delegationDepth = ctx.env.delegationDepth ?? 1;
      const tasks = parseTasks(args.tasks, planBudget, delegationDepth > 1);
      const plannerTasks = tasks.filter(task => task.planner === true);
      if (delegationDepth > 1 && plannerTasks.length > 0) throw new Error("goal_plan_depth_exceeded");
      const maxPlannerChildren = delegationDepth === 1 && ctx.env.delegationPlanner !== false
        ? MAX_GOAL_PLANNER_CHILDREN : childFanout(delegationDepth, ctx.env.delegationPlanner ?? true);
      if (plannerTasks.length > maxPlannerChildren) throw new Error("goal_plan_planner_fanout_exceeded");
      // Predict runtime needs against the host's current worker tools and approved runtime
      // catalogue. The model recommends only a declared capability; grants and execution remain
      // host-controlled. This replaces brittle keyword matching with task-graph classification.
      if (ctx.env.classifyPlanRuntimes) {
        try {
          const classified = await ctx.env.classifyPlanRuntimes({
            steps: tasks.map(task => ({ id: task.id, text: `${task.title}\n${task.subtask_spec}`.slice(0, 2_000), done: false, status: "pending" as const })),
            availableTools: [...(ctx.commands?.keys() ?? [])],
          });
          const byId = new Map(classified.filter(item => item.confidence >= 0.8 && item.capability).map(item => [item.stepId, item]));
          for (const task of tasks) {
            const recommendation = byId.get(task.id);
            if (!recommendation?.capability) continue;
            task.runtime_capability = recommendation.capability;
            task.runtime_confidence = recommendation.confidence;
            const resource = recommendation.resourceKey ?? `runtime.capability.${recommendation.capability.toLowerCase().replace(/[^a-z0-9.-]/g, "-")}`;
            if (recommendation.resourceKey) task.runtime_resource_key = recommendation.resourceKey;
            task.resource_keys = [...new Set([...(task.resource_keys ?? []), resource])].slice(0, 8);
            task.subtask_spec += `\nHost runtime recommendation (advisory, confidence ${recommendation.confidence.toFixed(2)}): ${recommendation.capability}. Use this only for commands that need it. Keep dependent commands in one environment/session when state must carry across commands; the runtime still enforces installed grants and availability.`;
          }
        } catch { /* Prediction is best-effort; execution does not depend on the model. */ }
      }
      const persist = ctx.env.orchestration?.persistGoalTasks;
      const spawn = ctx.env.orchestration?.spawnSubAgent;
      if (!persist || !spawn) throw new Error("goal orchestration is unavailable");
      if (!ctx.env.orchestration?.executeGoalDag) throw new Error("durable goal orchestration is unavailable");
      const dispatch = await ctx.env.orchestration.executeGoalDag(objective, tasks);
      if (tasks.some(task => dispatch.tasks[task.id]?.status !== "completed")) throw new Error(`goal_dag_incomplete:${JSON.stringify(dispatch)}`);
      return { objective, tasks, dispatch, context_isolation: "no_parent_conversation", max_output_tokens_per_worker: planBudget };
    },
  },
};
