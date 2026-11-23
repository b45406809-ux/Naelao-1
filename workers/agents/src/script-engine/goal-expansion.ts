import { MAX_SUB_AGENT_BUDGET_TOKENS } from "./sub-agent-output.js";
import { MAX_GOAL_TASKS, validateGoalDag, type GoalTask } from "./prebuilt/goal-planner.js";

export const GOAL_EXPANSION_OUTPUT_KEY = "naelao_goal_expansion_v1";
export const MAX_GOAL_EXPANSION_TASKS = 3;

export interface PreparedGoalExpansion {
  proposalId: string;
  tasks: GoalTask[];
}

const ALLOWED_CANDIDATE_KEYS = new Set([
  "id", "title", "subtask_spec", "dependencies", "file_paths", "budget_tokens",
  "acceptance_criteria", "evidence_checks", "human_review_required",
]);

/**
 * Read only the explicit structured worker control field. Ordinary prose and JSON-looking
 * strings are never interpreted as host control instructions.
 */
export function readGoalExpansionProposal(output: unknown): unknown[] | undefined {
  if (!output || typeof output !== "object" || Array.isArray(output)) return undefined;
  const record = output as Record<string, unknown>;
  if (!Object.hasOwn(record, GOAL_EXPANSION_OUTPUT_KEY)) return undefined;
  const proposal = record[GOAL_EXPANSION_OUTPUT_KEY];
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) throw new Error("invalid_goal_expansion_proposal");
  const value = proposal as Record<string, unknown>;
  if (value.version !== 1 || !Array.isArray(value.tasks)) throw new Error("invalid_goal_expansion_proposal");
  return value.tasks;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Stable receipt identity for an explicit proposal that host validation rejects. */
export async function fingerprintGoalExpansionProposal(parentId: string, proposedTasks: unknown[]): Promise<string> {
  let serialized: string;
  try { serialized = JSON.stringify([parentId, proposedTasks]) ?? `${parentId}:unserializable`; }
  catch { serialized = `${parentId}:unserializable`; }
  return sha256(serialized);
}

/**
 * Turn an untrusted worker proposal into a small, stable child graph. All authority-bearing
 * fields come from the completed parent task; proposals cannot choose a role, agent, runtime,
 * peer grant, model, or resource lock. The caller still has to admit and persist the tasks.
 */
export async function prepareGoalExpansion(args: {
  parent: GoalTask;
  existingTasks: readonly GoalTask[];
  proposedTasks: unknown[];
  remainingBudgetTokens: number;
}): Promise<PreparedGoalExpansion> {
  const { parent, existingTasks, proposedTasks, remainingBudgetTokens } = args;
  if (!existingTasks.some(task => task.id === parent.id)) throw new Error("goal_expansion_parent_missing");
  if ((parent.expansion_depth ?? 0) >= 1) throw new Error("goal_expansion_depth_exceeded");
  if (!Array.isArray(proposedTasks) || proposedTasks.length < 1 || proposedTasks.length > MAX_GOAL_EXPANSION_TASKS) throw new Error("goal_expansion_task_count_invalid");
  if (existingTasks.length + proposedTasks.length > MAX_GOAL_TASKS) throw new Error("goal_expansion_graph_limit_exceeded");
  if (!Number.isSafeInteger(remainingBudgetTokens) || remainingBudgetTokens < proposedTasks.length) throw new Error("goal_expansion_budget_exhausted");

  const localIds = new Set<string>();
  const parsed = proposedTasks.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_goal_expansion_task");
    const item = raw as Record<string, unknown>;
    if (Object.keys(item).some(key => !ALLOWED_CANDIDATE_KEYS.has(key))) throw new Error("goal_expansion_authority_field_denied");
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const subtaskSpec = typeof item.subtask_spec === "string" ? item.subtask_spec.trim() : "";
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(id) || localIds.has(id)) throw new Error("goal_expansion_task_id_invalid");
    if (!title || title.length > 200 || !subtaskSpec || subtaskSpec.length > 4_000) throw new Error("goal_expansion_task_text_invalid");
    localIds.add(id);

    const filePaths = item.file_paths === undefined
      ? [...parent.file_paths]
      : Array.isArray(item.file_paths) && item.file_paths.every(path => typeof path === "string")
        ? [...new Set(item.file_paths as string[])]
        : (() => { throw new Error("goal_expansion_file_boundary_invalid"); })();
    const parentFiles = new Set(parent.file_paths);
    if (filePaths.length > 32 || filePaths.some(path => !parentFiles.has(path))) throw new Error("goal_expansion_file_boundary_exceeded");

    const dependencies = item.dependencies === undefined
      ? []
      : Array.isArray(item.dependencies) && item.dependencies.every(dependency => typeof dependency === "string")
        ? [...new Set(item.dependencies as string[])]
        : (() => { throw new Error("goal_expansion_dependencies_invalid"); })();
    if (dependencies.length > MAX_GOAL_EXPANSION_TASKS || dependencies.some(dependency => !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(dependency) || !localIds.has(dependency) && !proposedTasks.some(candidate => Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate) && (candidate as Record<string, unknown>).id === dependency))) {
      throw new Error("goal_expansion_dependencies_invalid");
    }

    const requestedBudget = item.budget_tokens;
    if (requestedBudget !== undefined && (typeof requestedBudget !== "number" || !Number.isSafeInteger(requestedBudget) || requestedBudget < 1 || requestedBudget > MAX_SUB_AGENT_BUDGET_TOKENS)) {
      throw new Error("goal_expansion_budget_invalid");
    }
    return {
      id, title, subtask_spec: subtaskSpec, file_paths: filePaths, localDependencies: dependencies,
      ...(requestedBudget !== undefined ? { budget_tokens: Number(requestedBudget) } : {}),
      ...(item.acceptance_criteria !== undefined ? { acceptance_criteria: item.acceptance_criteria as string[] } : {}),
      ...(item.evidence_checks !== undefined ? { evidence_checks: item.evidence_checks as Array<{ criterion: string; operation: string }> } : {}),
      ...(item.human_review_required !== undefined ? { human_review_required: item.human_review_required as string[] } : {}),
    };
  });

  const defaultBudget = Math.max(1, Math.floor(remainingBudgetTokens / parsed.length));
  const totalBudget = parsed.reduce((sum, item) => sum + (item.budget_tokens ?? defaultBudget), 0);
  if (totalBudget > remainingBudgetTokens) throw new Error("goal_expansion_budget_exceeded");

  const canonical = parsed.map(item => ({
    id: item.id, title: item.title, subtask_spec: item.subtask_spec, file_paths: item.file_paths,
    dependencies: item.localDependencies, budget_tokens: item.budget_tokens ?? defaultBudget,
    ...(item.acceptance_criteria !== undefined ? { acceptance_criteria: item.acceptance_criteria } : {}),
    ...(item.evidence_checks !== undefined ? { evidence_checks: item.evidence_checks } : {}),
    ...(item.human_review_required !== undefined ? { human_review_required: item.human_review_required } : {}),
  }));
  const proposalId = await sha256(JSON.stringify([parent.id, canonical]));
  const namespaced = new Map(parsed.map(item => [item.id, `x${proposalId.slice(0, 24)}-${item.id}`]));
  const tasks = parsed.map((item): GoalTask => {
    const localDependencies = item.localDependencies.map(id => namespaced.get(id)!);
    const isRoot = localDependencies.length === 0;
    const dependencies = isRoot ? [parent.id, ...localDependencies] : localDependencies;
    return {
      id: namespaced.get(item.id)!, title: item.title, subtask_spec: item.subtask_spec,
      assigned_role: parent.assigned_role,
      ...(parent.context_affinity ? { context_affinity: parent.context_affinity } : {}),
      ...(parent.agent_id ? { agent_id: parent.agent_id } : {}),
      planner: false,
      ...(parent.resource_keys ? { resource_keys: [...parent.resource_keys] } : {}),
      ...(parent.runtime_capability ? { runtime_capability: parent.runtime_capability } : {}),
      ...(parent.runtime_confidence !== undefined ? { runtime_confidence: parent.runtime_confidence } : {}),
      ...(parent.runtime_resource_key ? { runtime_resource_key: parent.runtime_resource_key } : {}),
      ...(parent.priority !== undefined ? { priority: parent.priority } : {}),
      ...(parent.decision_refs ? { decision_refs: structuredClone(parent.decision_refs) } : {}),
      file_paths: item.file_paths,
      dependencies,
      ...(item.acceptance_criteria !== undefined ? { acceptance_criteria: item.acceptance_criteria } : {}),
      ...(item.evidence_checks !== undefined ? { evidence_checks: item.evidence_checks } : {}),
      ...(item.human_review_required !== undefined ? { human_review_required: item.human_review_required } : {}),
      budget_tokens: item.budget_tokens ?? defaultBudget,
      expansion_depth: (parent.expansion_depth ?? 0) + 1,
    };
  });
  validateGoalDag([...existingTasks, ...tasks]);
  return { proposalId, tasks };
}
