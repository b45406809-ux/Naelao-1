import type { ChoiceDecision, FastDecisionGateway } from "@naelao/agent-sdk";

export type LoopEvaluation = "CONTINUE" | "RETRY" | "MERGE_PR" | "ESCALATE";

/** Fast post-tool judgment. Deterministic budgets, approvals, and System 2 retain authority. */
export async function evaluateLoopAfterTool(
  sentry: Pick<FastDecisionGateway, "choice"> | undefined,
  input: { goal: string; operation: string; ok: boolean; output?: unknown; error?: string; completedSteps: number }
): Promise<ChoiceDecision<LoopEvaluation> | null> {
  if (!sentry) return null;
  try {
    const decision = await sentry.choice<LoopEvaluation>({
      state: {
        goal: input.goal.slice(0, 4_000),
        latest_tool: {
          operation: input.operation,
          ok: input.ok,
          ...(input.output !== undefined ? { output: JSON.stringify(input.output).slice(0, 4_000) } : {}),
          ...(input.error ? { error: input.error.slice(0, 2_000) } : {}),
        },
        completed_steps: input.completedSteps,
      },
      instructions: "What should the agent loop do after this tool result? Choose MERGE_PR only when the requested work appears complete and the next System 2 turn should compose the final answer.",
      criteria: {
        CONTINUE: "The result is useful, but the goal still needs another distinct action or verification.",
        RETRY: "The latest action failed in a way that may be corrected or retried with changed arguments.",
        MERGE_PR: "The goal appears fulfilled and verified enough to finalize; no additional tool action is needed.",
        ESCALATE: "The result shows a human decision, permission, missing information, or safety escalation is required.",
      },
      policyCode: "post_tool_loop_evaluator_v1",
    });
    return (decision.confidence ?? 0) >= 0.85 && decision.provider !== "deterministic" ? decision : null;
  } catch {
    return null;
  }
}
