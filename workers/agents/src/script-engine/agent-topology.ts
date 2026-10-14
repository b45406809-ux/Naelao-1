/** The public capability boundary between persistent planners and leaf workers. */
export type PlannerScope = "space" | "project";

/** Installed on every persistent agent so each one can lead work and use the execution ladder. */
export const UNIVERSAL_PLANNER_PREBUILTS = [
  "goal-planner", "sub-agent", "project-coordination", "model-race", "executive-cabinet",
] as const;

/** The Bash implementation that routes commands across the configured execution ceiling. */
export const UNIVERSAL_EXECUTION_PREBUILTS = ["code-exec", "runtime-discovery"] as const;

export const UNIVERSAL_AGENT_BASELINE_PREBUILTS = [
  ...UNIVERSAL_EXECUTION_PREBUILTS,
  ...UNIVERSAL_PLANNER_PREBUILTS,
] as const;

const UNIVERSAL_REPL_OPERATIONS = new Set([
  "Bash", "Read", "tools.search", "tools.describe",
]);

const PLANNER_OPERATIONS = new Set([
  "engine.plan_and_delegate_goal",
  "agent.spawn",
  "model.race",
  "agent.list_models",
  "thread.list_project_agents",
  "thread.consult",
  "thread.delegate",
  "thread.list",
  "thread.read",
  "thread.search",
  "runtime.list",
  "runtime.find",
]);

/**
 * A persistent agent is intentionally a planner. It can inspect through the shell surface and
 * coordinate workers, but it cannot directly invoke a worker-owned domain operation. A cabinet
 * delegation is marked internally by ScriptToolSurface and is the only way a Space planner may
 * execute the cabinet worker's bounded operation.
 */
export function isPlannerOperationAllowed(scope: PlannerScope, name: string): boolean {
  if (UNIVERSAL_REPL_OPERATIONS.has(name) || PLANNER_OPERATIONS.has(name)) return true;
  return scope === "space" && name === "delegate_to_space_worker";
}
