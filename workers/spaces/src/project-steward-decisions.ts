import type { ProjectStewardReview } from "./project-steward.js";

export type ProjectStewardDecisionAction = "acknowledge" | "snooze" | "dismiss";

/** Bind an owner decision to the precise signal evidence, so changed project facts create a new
 * review and cannot inherit an old dismissal. */
export async function projectStewardReviewKey(review: ProjectStewardReview): Promise<string> {
  const canonical = JSON.stringify({
    project_id: review.project_id,
    recommendation: review.recommendation,
    confidence: review.confidence,
    evidence: [...review.evidence].sort((a, b) => a.kind.localeCompare(b.kind)),
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function isProjectStewardDecisionAction(value: unknown): value is ProjectStewardDecisionAction {
  return value === "acknowledge" || value === "snooze" || value === "dismiss";
}
