import type { GoalDagJournal } from "../script-engine/goal-dag.js";
import { classifyWorkerOutputConflicts, type WorkerOutputConflictCandidate } from "./worker-output-conflicts.js";

export interface DecisionChangeCandidate {
  decision: { id: string; revision: number };
  tasks: Array<{ id: string; reportedPaths: string[] }>;
  kind: "shared_decision_distinct_path_reports";
  evidence: "worker_reported_paths";
  status: "review_candidate";
}

const MAX_TASKS = 12;
const MAX_PATHS_PER_TASK = 20;
const MAX_CANDIDATES = 12;

function safeReportedPaths(output: unknown): string[] {
  if (!output || typeof output !== "object" || Array.isArray(output)) return [];
  const values = (output as Record<string, unknown>).modifiedFiles;
  if (!Array.isArray(values)) return [];
  return [...new Set(values.slice(0, MAX_PATHS_PER_TASK).flatMap(value => {
    if (typeof value !== "string" || value.length > 256 || value.startsWith("/") || value.includes("\\")
      || /[\u0000-\u001f\u007f]/.test(value)) return [];
    const segments = value.split("/");
    if (segments.some(segment => !segment || segment === "." || segment === "..")) return [];
    return [value];
  }))].sort();
}

/**
 * Emit review candidates only when separate completed workers report distinct paths under the
 * same exact Project decision revision. Worker path reports are untrusted hints, not proof of a
 * semantic conflict, and this helper grants no publication authority.
 */
export function projectDecisionChangeCandidates(
  tasks: readonly { id: string; decision_refs?: Array<{ id: string; revision: number }> }[],
  journal: Pick<GoalDagJournal, "tasks">,
): DecisionChangeCandidate[] {
  const groups = new Map<string, { decision: { id: string; revision: number }; tasks: Map<string, string[]> }>();
  for (const task of tasks.slice(0, MAX_TASKS)) {
    const state = journal.tasks[task.id];
    if (state?.status !== "completed" || state.result?.ok !== true) continue;
    const paths = safeReportedPaths(state.result.output);
    if (!paths.length) continue;
    for (const ref of (task.decision_refs ?? []).slice(0, 4)) {
      if (!ref || typeof ref.id !== "string" || ref.id.length < 1 || ref.id.length > 128
        || !Number.isSafeInteger(ref.revision) || ref.revision < 1) continue;
      const key = JSON.stringify([ref.id, ref.revision]);
      const group = groups.get(key) ?? { decision: { id: ref.id, revision: ref.revision }, tasks: new Map() };
      group.tasks.set(task.id, paths);
      groups.set(key, group);
    }
  }
  const candidates: DecisionChangeCandidate[] = [];
  for (const group of groups.values()) {
    const entries = [...group.tasks.entries()].sort(([left], [right]) => left.localeCompare(right));
    if (entries.length < 2) continue;
    const paths = entries.map(([, reportedPaths]) => new Set(reportedPaths));
    if (paths.some((left, index) => paths.slice(index + 1).some(right => [...left].some(path => right.has(path))))) continue;
    candidates.push({ decision: group.decision,
      tasks: entries.map(([id, reportedPaths]) => ({ id, reportedPaths })),
      kind: "shared_decision_distinct_path_reports", evidence: "worker_reported_paths", status: "review_candidate" });
    if (candidates.length === MAX_CANDIDATES) break;
  }
  return candidates;
}

export interface DecisionWorkerOutputConflicts {
  decision: { id: string; revision: number };
  candidates: WorkerOutputConflictCandidate[];
}

/**
 * Run the deterministic conflict classes per exact decision revision over completed workers'
 * reported paths. The host keeps no diff text, so paths that need it surface as `unknown`.
 */
export function projectWorkerOutputConflictCandidates(
  tasks: readonly { id: string; decision_refs?: Array<{ id: string; revision: number }> }[],
  journal: Pick<GoalDagJournal, "tasks">,
): DecisionWorkerOutputConflicts[] {
  const groups = new Map<string, { decision: { id: string; revision: number }; outputs: Map<string, { worker_id: string; changed_paths: string[] }> }>();
  for (const task of tasks.slice(0, MAX_TASKS)) {
    const state = journal.tasks[task.id];
    if (state?.status !== "completed" || state.result?.ok !== true) continue;
    const paths = safeReportedPaths(state.result.output);
    if (!paths.length) continue;
    for (const ref of (task.decision_refs ?? []).slice(0, 4)) {
      if (!ref || typeof ref.id !== "string" || ref.id.length < 1 || ref.id.length > 128
        || !Number.isSafeInteger(ref.revision) || ref.revision < 1) continue;
      const key = JSON.stringify([ref.id, ref.revision]);
      const group = groups.get(key) ?? { decision: { id: ref.id, revision: ref.revision }, outputs: new Map() };
      group.outputs.set(task.id, { worker_id: state.workerId, changed_paths: paths });
      groups.set(key, group);
    }
  }
  const results: DecisionWorkerOutputConflicts[] = [];
  for (const group of groups.values()) {
    if (group.outputs.size < 2) continue;
    const candidates = classifyWorkerOutputConflicts([...group.outputs.values()]);
    if (candidates.length) results.push({ decision: group.decision, candidates });
    if (results.length === MAX_CANDIDATES) break;
  }
  return results;
}
