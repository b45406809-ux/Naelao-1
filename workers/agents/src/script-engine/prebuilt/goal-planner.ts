import type { UniversalAgentRole } from "@naelao/agent-sdk";
import type { PrebuiltScript } from "./index.js";

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
    if (!Number.isSafeInteger(task.budget_tokens) || task.budget_tokens < 1 || task.budget_tokens > 2_000) throw new Error(`task '${task.id}' budget_tokens must be within 1..2000`);
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

function parseTasks(value: unknown): GoalTask[] {
  if (!Array.isArray(value)) throw new Error("tasks must be an array");
  const tasks = value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid goal task");
    const task = raw as Record<string, unknown>;
    const filePaths = Array.isArray(task.file_paths) ? task.file_paths.map(String) : [];
    const contextAffinity: GoalTask["context_affinity"] = task.context_affinity === "shared" || task.context_affinity === "isolated"
      ? task.context_affinity
      : filePaths.length > 0 ? "shared" : "isolated";
    return {
      id: String(task.id ?? `task-${index + 1}`), title: String(task.title ?? ""),
      subtask_spec: String(task.subtask_spec ?? ""),
      assigned_role: String(task.assigned_role ?? "worker") as UniversalAgentRole,
      context_affinity: contextAffinity,
      ...(typeof task.agent_id === "string" ? { agent_id: task.agent_id } : {}),
      ...(task.planner === true ? { planner: true } : {}),
      file_paths: filePaths,
      dependencies: Array.isArray(task.dependencies) ? task.dependencies.map(String) : [],
      budget_tokens: task.budget_tokens === undefined ? 1_800 : task.budget_tokens as number,
    };
  });
  validateGoalDag(tasks); return tasks;
}

export const goalPlanner: PrebuiltScript = {
  name: "goal-planner", domain: "orchestration", requires_tier: 2,
  description: "Persist a frontier-planned task DAG and concurrently dispatch isolated edge workers.",
  paramHints: { "engine.plan_and_delegate_goal": "objective and tasks required. Each task: id, title, subtask_spec, assigned_role, context_affinity? (shared|isolated; inferred from file_paths when omitted), agent_id? (own configured worker), planner? (depth-2 subplanner), file_paths, dependencies?, budget_tokens<=2000. Worker model is selected by runtime policy, never by a task-supplied model id." },
  operations: {
    async "engine.plan_and_delegate_goal"(args, ctx) {
      const objective = String(args.objective ?? "").trim();
      if (!objective) throw new Error("objective is required");
      const tasks = parseTasks(args.tasks);
      const persist = ctx.env.orchestration?.persistGoalTasks;
      const spawn = ctx.env.orchestration?.spawnSubAgent;
      if (!persist || !spawn) throw new Error("goal orchestration is unavailable");
      if (!ctx.env.orchestration?.executeGoalDag) throw new Error("durable goal orchestration is unavailable");
      const dispatch = await ctx.env.orchestration.executeGoalDag(objective, tasks);
      if (tasks.some(task => dispatch.tasks[task.id]?.status !== "completed")) throw new Error(`goal_dag_incomplete:${JSON.stringify(dispatch)}`);
      return { objective, tasks, dispatch, context_isolation: "no_parent_conversation", max_output_tokens_per_worker: 2_000 };
    },
  },
};
