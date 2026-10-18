export interface ProjectStewardFact {
  project_id: string;
  project_name: string;
  last_activity_at: string | null;
  created_at: string;
  failed_routines: Array<{ id: string; consecutive_failures: number }>;
  pending_task_count?: number;
  in_progress_task_count?: number;
  blocked_task_count?: number;
  active_extension_count?: number;
  unhealthy_extension_connection_count?: number;
}

export interface ProjectStewardReview {
  project_id: string;
  project_name: string;
  recommendation: "inspect_routine" | "review_blocked_work" | "inspect_extension_health" | "owner_check_in";
  confidence: "low" | "high";
  priority: number;
  evidence: Array<{ kind: "routine_failures" | "blocked_tasks" | "connection_failures" | "inactivity" | "pending_tasks" | "active_extensions"; count?: number; days?: number; last_activity_at?: string | null }>;
}

/** Deterministic, advisory-only portfolio ranking. It deliberately cannot change project or
 * extension lifecycle state; model-generated summaries can be layered on top later. */
export function rankProjectStewardReviews(
  facts: readonly ProjectStewardFact[],
  now = Date.now(),
  inactivityThresholdDays = 30,
): ProjectStewardReview[] {
  const inactivityThresholdMs = Math.max(1, inactivityThresholdDays) * 24 * 60 * 60 * 1000;
  const reviews: ProjectStewardReview[] = [];
  for (const fact of facts) {
    const failureCount = fact.failed_routines.reduce((sum, job) => sum + Math.max(0, job.consecutive_failures), 0);
    const lastActivity = fact.last_activity_at ?? fact.created_at;
    const activityMs = Date.parse(lastActivity);
    const inactiveDays = Number.isFinite(activityMs) ? Math.max(0, Math.floor((now - activityMs) / 86_400_000)) : 0;
    if (failureCount > 0) {
      reviews.push({
        project_id: fact.project_id,
        project_name: fact.project_name,
        recommendation: "inspect_routine",
        confidence: "high",
        priority: 100 + Math.min(failureCount, 20),
        evidence: [{ kind: "routine_failures", count: failureCount }],
      });
    } else if ((fact.blocked_task_count ?? 0) > 0) {
      const blockedCount = fact.blocked_task_count ?? 0;
      reviews.push({
        project_id: fact.project_id,
        project_name: fact.project_name,
        recommendation: "review_blocked_work",
        confidence: "high",
        priority: 80 + Math.min(blockedCount, 20),
        evidence: [{ kind: "blocked_tasks", count: blockedCount }],
      });
    } else if ((fact.unhealthy_extension_connection_count ?? 0) > 0) {
      const failureCount = fact.unhealthy_extension_connection_count ?? 0;
      reviews.push({
        project_id: fact.project_id,
        project_name: fact.project_name,
        recommendation: "inspect_extension_health",
        confidence: "high",
        priority: 70 + Math.min(failureCount, 20),
        evidence: [{ kind: "connection_failures", count: failureCount }],
      });
    } else if (inactiveDays * 86_400_000 >= inactivityThresholdMs) {
      const evidence: ProjectStewardReview["evidence"] = [
        { kind: "inactivity", days: inactiveDays, last_activity_at: fact.last_activity_at },
      ];
      const pendingCount = fact.pending_task_count ?? 0;
      const extensionCount = fact.active_extension_count ?? 0;
      if (pendingCount > 0) evidence.push({ kind: "pending_tasks", count: pendingCount });
      if (extensionCount > 0) evidence.push({ kind: "active_extensions", count: extensionCount });
      reviews.push({
        project_id: fact.project_id,
        project_name: fact.project_name,
        recommendation: "owner_check_in",
        confidence: "low",
        priority: 30 + Math.min(inactiveDays - inactivityThresholdDays, 30),
        evidence,
      });
    }
  }
  return reviews.sort((a, b) => b.priority - a.priority || a.project_id.localeCompare(b.project_id));
}
