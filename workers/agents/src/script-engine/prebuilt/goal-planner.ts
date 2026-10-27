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
  assigned_role: UniversalAgentRole;
  context_affinity?: "shared" | "isolated";
  agent_id?: string;
  planner?: boolean;
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
    if (!Number.isSafeInteger(task.budget_tokens) || task.budget_tokens < 1 || task.budget_tokens > MAX_SUB_AGENT_BUDGET_TOKENS) throw new Error(`task '${task.id}' budget_tokens must be within 1..${MAX_SUB_AGENT_BUDGET_TOKENS}`);
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
    return {
      id: String(task.id ?? `task-${index + 1}`), title: String(task.title ?? ""),
      subtask_spec: String(task.subtask_spec ?? ""),
      assigned_role: String(task.assigned_role ?? "worker") as UniversalAgentRole,
      context_affinity: contextAffinity,
      ...(typeof task.agent_id === "string" ? { agent_id: task.agent_id } : {}),
      ...(task.planner === true ? { planner: true } : {}),
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
  paramHints: { "engine.coordination_patterns": "List advisory, versioned coordination patterns. Instantiate tasks only when useful; patterns do not grant capabilities.", "engine.plan_and_delegate_goal": "objective and tasks required. Each task: id, title, subtask_spec (give the worker a detailed outcome and constraints; let it plan with its assigned capability subset), assigned_role, context_affinity? (shared|isolated; inferred from file_paths when omitted), agent_id? (own configured worker), planner? (depth-2 subplanner), file_paths, dependencies?, budget_tokens up to your subscription plan's worker limit. Omit budget_tokens to use that limit. The host selects a subset of the worker's configured related tools and skills; selection never grants unconfigured tools. Keep dependent order intact and independent work parallel where useful. Worker model is selected by runtime policy, never by a task-supplied model id." },
  operations: {
    async "engine.coordination_patterns"() {
      return { patterns: structuredClone(COORDINATION_PATTERNS), advisory: true };
    },
    async "engine.plan_and_delegate_goal"(args, ctx) {
      const objective = String(args.objective ?? "").trim();
      if (!objective) throw new Error("objective is required");
      const planBudget = ctx.env.workerTokenBudget ?? DEFAULT_SUB_AGENT_BUDGET_TOKENS;
      const tasks = parseTasks(args.tasks, planBudget);
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
