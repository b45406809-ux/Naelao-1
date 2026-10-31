import type { UniversalAgentRole } from "@naelao/agent-sdk";
import type { PrebuiltScript } from "./index.js";
import { DEFAULT_SUB_AGENT_BUDGET_TOKENS, MAX_SUB_AGENT_BUDGET_TOKENS } from "../sub-agent-output.js";

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
  assigned_role: UniversalAgentRole;
  context_affinity?: "shared" | "isolated";
  agent_id?: string;
  planner?: boolean;
  /** Scheduling hint for a shared mutable environment; host controls remain authoritative. */
  resource_keys?: string[];
  /** System One recommendation from the installed, host-approved runtime catalogue. */
  runtime_capability?: string;
  runtime_confidence?: number;
  /** Host-generated exact lock associated with the approved runtime; planner input is discarded. */
  runtime_resource_key?: string;
  /** Bounded queue priority; host caps and ages it to prevent starvation. */
  priority?: number;
  file_paths: string[];
  dependencies?: string[];
  budget_tokens: number;
}

export function validateGoalDag(tasks: GoalTask[]): void {
  if (tasks.length > 12) throw new Error("goal plan exceeds 12 tasks");
  if (!tasks.length) throw new Error("goal plan must contain at least one task");
  const ids = new Set(tasks.map((task) => task.id));
  if (ids.size !== tasks.length) throw new Error("goal task ids must be unique");
  for (const task of tasks) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(task.id) || !task.title || !task.subtask_spec || !Array.isArray(task.file_paths)) throw new Error(`invalid goal task '${task.id}'`);
    if (typeof task.assigned_role !== "string" || !task.assigned_role.trim() || task.assigned_role.length > 128) throw new Error(`task '${task.id}' has an invalid assigned_role`);
    if (task.acceptance_criteria !== undefined && (!Array.isArray(task.acceptance_criteria) || task.acceptance_criteria.length < 1 || task.acceptance_criteria.length > 8 || task.acceptance_criteria.some(item => typeof item !== "string" || !item.trim() || item.length > 500))) throw new Error(`task '${task.id}' has invalid acceptance_criteria`);
    if (task.evidence_checks !== undefined && (!Array.isArray(task.evidence_checks) || task.evidence_checks.length > 8 || task.evidence_checks.some(check => !check || typeof check.criterion !== "string" || !task.acceptance_criteria?.includes(check.criterion) || typeof check.operation !== "string" || !/^(artifact\.sha256|workspace\.exists|workspace\.sha256):[^\s]{1,256}$/.test(check.operation)) || new Set(task.evidence_checks.map(check => check.criterion)).size !== task.evidence_checks.length)) throw new Error(`task '${task.id}' has invalid evidence_checks`);
    if (task.evidence_checks !== undefined && task.evidence_checks.some(check => !task.file_paths.includes(check.operation.split(":")[1] ?? ""))) throw new Error(`task '${task.id}' evidence check paths must be declared`);
    if (!Number.isSafeInteger(task.budget_tokens) || task.budget_tokens < 1 || task.budget_tokens > MAX_SUB_AGENT_BUDGET_TOKENS) throw new Error(`task '${task.id}' budget_tokens must be within 1..${MAX_SUB_AGENT_BUDGET_TOKENS}`);
    if (task.resource_keys !== undefined && (!Array.isArray(task.resource_keys) || task.resource_keys.length > 8 || task.resource_keys.some(key => typeof key !== "string" || !/^[a-z][a-z0-9._:-]{0,95}$/.test(key)) || new Set(task.resource_keys).size !== task.resource_keys.length)) throw new Error(`task '${task.id}' has invalid resource_keys`);
    if (task.runtime_capability !== undefined && (typeof task.runtime_capability !== "string" || !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(task.runtime_capability))) throw new Error(`task '${task.id}' has an invalid runtime_capability`);
    if (task.runtime_confidence !== undefined && (!Number.isFinite(task.runtime_confidence) || task.runtime_confidence < 0 || task.runtime_confidence > 1)) throw new Error(`task '${task.id}' has an invalid runtime_confidence`);
    if (task.runtime_resource_key !== undefined && (typeof task.runtime_resource_key !== "string" || !/^runtime\.[a-z-]+\.[a-f0-9]{40}$/.test(task.runtime_resource_key))) throw new Error(`task '${task.id}' has an invalid runtime_resource_key`);
    if (task.priority !== undefined && (!Number.isSafeInteger(task.priority) || task.priority < -10 || task.priority > 10)) throw new Error(`task '${task.id}' priority must be within -10..10`);
    for (const dependency of task.dependencies ?? []) if (!ids.has(dependency) || dependency === task.id) throw new Error(`task '${task.id}' has invalid dependency '${dependency}'`);
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
}

function parseTasks(value: unknown, planBudget: number): GoalTask[] {
  if (!Array.isArray(value)) throw new Error("tasks must be an array");
  const tasks = value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid goal task");
    const task = raw as Record<string, unknown>;
    const filePaths = Array.isArray(task.file_paths) ? task.file_paths.map(String) : [];
    const contextAffinity: GoalTask["context_affinity"] = task.context_affinity === "shared" || task.context_affinity === "isolated"
      ? task.context_affinity
      : filePaths.length > 0 ? "shared" : "isolated";
    const requestedBudget = task.budget_tokens === undefined ? planBudget : task.budget_tokens;
    if (typeof requestedBudget !== "number" || !Number.isSafeInteger(requestedBudget)
      || requestedBudget < 1 || requestedBudget > MAX_SUB_AGENT_BUDGET_TOKENS) {
      throw new Error(`task '${String(task.id ?? index + 1)}' has an invalid budget_tokens`);
    }
    const subtaskSpec = String(task.subtask_spec ?? "");
    const declaredResources = Array.isArray(task.resource_keys) ? task.resource_keys.map(String) : undefined;
    return {
      id: String(task.id ?? `task-${index + 1}`), title: String(task.title ?? ""),
      subtask_spec: subtaskSpec,
      ...(task.acceptance_criteria !== undefined ? { acceptance_criteria: task.acceptance_criteria as string[] } : {}),
      ...(task.evidence_checks !== undefined ? { evidence_checks: task.evidence_checks as Array<{ criterion: string; operation: string }> } : {}),
      assigned_role: String(task.assigned_role ?? "worker") as UniversalAgentRole,
      context_affinity: contextAffinity,
      ...(typeof task.agent_id === "string" ? { agent_id: task.agent_id } : {}),
      ...(task.planner === true ? { planner: true } : {}),
      ...(declaredResources ? { resource_keys: declaredResources } : {}),
      ...(typeof task.priority === "number" ? { priority: task.priority } : {}),
      file_paths: filePaths,
      dependencies: Array.isArray(task.dependencies) ? task.dependencies.map(String) : [],
      budget_tokens: Math.min(planBudget, requestedBudget),
    };
  });
  validateGoalDag(tasks); return tasks;
}

export const goalPlanner: PrebuiltScript = {
  name: "goal-planner", domain: "orchestration", requires_tier: 2,
  description: "Persist a frontier-planned task DAG and concurrently dispatch isolated edge workers.",
  paramHints: { "engine.coordination_patterns": "List advisory, versioned coordination patterns. Instantiate tasks only when useful; patterns do not grant capabilities.", "engine.plan_and_delegate_goal": "objective and tasks required. Each task: id, title, subtask_spec (give the worker a detailed outcome and constraints; let it plan with its assigned capability subset), assigned_role, acceptance_criteria? (1-8 concrete outcomes, each at most 500 characters), priority? (-10..10 queue preference; host applies aging), context_affinity? (shared|isolated; inferred from file_paths when omitted), resource_keys? (up to 8 shared mutable environment keys; tasks sharing one are scheduled serially within this DAG, while unrelated ready work can proceed; advisory scheduling only), agent_id? (own configured worker), planner? (depth-2 subplanner), file_paths, dependencies?, budget_tokens up to your subscription plan's worker limit. Omit budget_tokens to use that limit. The host selects a subset of the worker's configured related tools and skills; selection never grants unconfigured tools. Keep dependent order intact and independent work parallel where useful. Worker model is selected by runtime policy, never by a task-supplied model id." },
  operations: {
    async "engine.coordination_patterns"() {
      return { patterns: structuredClone(COORDINATION_PATTERNS), advisory: true };
    },
    async "engine.plan_and_delegate_goal"(args, ctx) {
      const objective = String(args.objective ?? "").trim();
      if (!objective) throw new Error("objective is required");
      const planBudget = ctx.env.workerTokenBudget ?? DEFAULT_SUB_AGENT_BUDGET_TOKENS;
      const tasks = parseTasks(args.tasks, planBudget);
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
