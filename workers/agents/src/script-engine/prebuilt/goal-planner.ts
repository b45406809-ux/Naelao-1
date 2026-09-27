import type { UniversalAgentRole } from "@naelao/agent-sdk";
import type { PrebuiltScript } from "./index.js";

export interface GoalTask {
  id: string;
  title: string;
  subtask_spec: string;
  assigned_role: UniversalAgentRole;
  model?: string;
  file_paths: string[];
  dependencies?: string[];
  budget_tokens: number;
}

export function validateGoalDag(tasks: GoalTask[]): void {
  if (!tasks.length) throw new Error("goal plan must contain at least one task");
  const ids = new Set(tasks.map((task) => task.id));
  if (ids.size !== tasks.length) throw new Error("goal task ids must be unique");
  for (const task of tasks) {
    if (!task.id || !task.title || !task.subtask_spec || !Array.isArray(task.file_paths)) throw new Error(`invalid goal task '${task.id}'`);
    if (task.budget_tokens < 1 || task.budget_tokens > 2_000) throw new Error(`task '${task.id}' budget_tokens must be within 1..2000`);
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
    const task = raw as Record<string, unknown>;
    return {
      id: String(task.id ?? `task-${index + 1}`), title: String(task.title ?? ""),
      subtask_spec: String(task.subtask_spec ?? ""),
      assigned_role: String(task.assigned_role ?? "DEV_OPERATOR") as UniversalAgentRole,
      ...(typeof task.model === "string" ? { model: task.model } : {}),
      file_paths: Array.isArray(task.file_paths) ? task.file_paths.map(String) : [],
      dependencies: Array.isArray(task.dependencies) ? task.dependencies.map(String) : [],
      budget_tokens: Math.min(2_000, Number(task.budget_tokens ?? 1_800)),
    };
  });
  validateGoalDag(tasks); return tasks;
}

export const goalPlanner: PrebuiltScript = {
  name: "goal-planner", domain: "orchestration", requires_tier: 2,
  description: "Persist a frontier-planned task DAG and concurrently dispatch isolated edge workers.",
  paramHints: { "engine.plan_and_delegate_goal": "objective and tasks required. Each task: id, title, subtask_spec, assigned_role, model?, file_paths, dependencies?, budget_tokens<=2000." },
  operations: {
    async "engine.plan_and_delegate_goal"(args, ctx) {
      const objective = String(args.objective ?? "").trim();
      if (!objective) throw new Error("objective is required");
      const tasks = parseTasks(args.tasks);
      const persist = ctx.env.orchestration?.persistGoalTasks;
      const spawn = ctx.env.orchestration?.spawnSubAgent;
      if (!persist || !spawn) throw new Error("goal orchestration is unavailable");
      await persist(tasks);
      // The worker sees only its specification and named file boundary; never parent history.
      const receipt = await spawn({ tasks: tasks.map((task) => ({
        goal: `<isolated_subtask>\n${task.subtask_spec}\n</isolated_subtask>\n<file_boundary>${task.file_paths.join(", ")}</file_boundary>`,
        role: task.assigned_role, ...(task.model ? { model: task.model } : {}), maxTokens: task.budget_tokens,
      })) });
      return { objective, tasks, dispatch: receipt, context_isolation: "subtask_and_file_slice_only", max_context_tokens: 2_000 };
    },
  },
};
