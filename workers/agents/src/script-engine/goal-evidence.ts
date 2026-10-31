/** Evidence must be constructed by the host from independently executed checks. */
export interface GoalEvidence {
  criterion: string;
  source: "host_check" | "human_review";
  outcome: "passed" | "failed" | "uncertain";
  reference: string;
}

/** Evaluate only host-supplied evidence; worker claims are not evidence. */
export function evaluateGoalEvidence(criteria: readonly string[], evidence: readonly GoalEvidence[]): { outcome: "passed" | "failed" | "uncertain"; reason: string } {
  if (!criteria.length || criteria.length > 8 || criteria.some(c => typeof c !== "string" || !c.trim() || c.length > 500)) return { outcome: "uncertain", reason: "Acceptance criteria are missing or invalid" };
  if (new Set(criteria).size !== criteria.length || evidence.length > 64) return { outcome: "uncertain", reason: "Evidence or criteria are ambiguous" };
  for (const item of evidence) {
    if (!item || !criteria.includes(item.criterion) || !["host_check", "human_review"].includes(item.source) || !["passed", "failed", "uncertain"].includes(item.outcome) || typeof item.reference !== "string" || !item.reference.trim() || item.reference.length > 500) return { outcome: "uncertain", reason: "Invalid evidence" };
  }
  if (evidence.some(item => item.outcome === "failed")) return { outcome: "failed", reason: "An independent check failed" };
  if (criteria.some(criterion => !evidence.some(item => item.criterion === criterion && item.outcome === "passed") || evidence.some(item => item.criterion === criterion && item.outcome === "uncertain"))) return { outcome: "uncertain", reason: "Independent evidence is incomplete or uncertain" };
  return { outcome: "passed", reason: "Every criterion has independent passing evidence" };
}
