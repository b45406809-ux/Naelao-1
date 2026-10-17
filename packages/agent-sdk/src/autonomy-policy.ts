/**
 * User-facing autonomy language for the legacy approval-policy records.
 *
 * This is a presentation/compatibility adapter, not an authorization decision. The runtime must
 * continue to enforce the verified principal, capability grants, project scope, approval gates,
 * and budgets on every operation.
 */
export type StoredApprovalMode = "always_ask" | "gate_unless_listed" | "gate_listed" | "yolo";

export interface StoredAutonomyPolicy {
  approval_mode: StoredApprovalMode;
  auto_approved_actions: readonly string[];
}

export type AutonomyLevel = "ask_first" | "approved_actions" | "run_within_limits" | "custom";

export interface AutonomyPresentation {
  level: AutonomyLevel;
  label: string;
  explanation: string;
}

export function presentAutonomyPolicy(policy: StoredAutonomyPolicy | null | undefined): AutonomyPresentation {
  if (!policy) {
    return {
      level: "ask_first",
      label: "Ask before acting",
      explanation: "No saved autonomy setting was found, so use the safe ask-first default.",
    };
  }

  const approvedCount = Array.isArray(policy.auto_approved_actions)
    ? policy.auto_approved_actions.length
    : 0;

  if (policy.approval_mode === "gate_listed") {
    return {
      level: "custom",
      label: "Custom approval rules",
      explanation: "Selected actions require approval; the runtime still enforces grants and limits.",
    };
  }

  if (policy.approval_mode === "yolo") {
    if (approvedCount > 0) {
      return {
        level: "custom",
        label: "Custom approval rules",
        explanation: "This policy combines autonomous execution with an explicit action list.",
      };
    }
    return {
      level: "run_within_limits",
      label: "Run within grants and limits",
      explanation: "Runs without an extra prompt only within granted tools, verified role, approval gates, and configured budgets.",
    };
  }

  if (approvedCount > 0) {
    return {
      level: "approved_actions",
      label: "Run approved actions; ask for others",
      explanation: String(approvedCount) + " explicitly approved action" + (approvedCount === 1 ? "" : "s") + " may run without asking; other actions require approval.",
    };
  }

  return {
    level: "ask_first",
    label: "Ask before acting",
    explanation: "Actions require approval unless another server-side policy applies.",
  };
}
