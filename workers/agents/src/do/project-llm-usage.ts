export type ProjectLlmPayer = "space_wallet" | "unknown";

export function projectLlmUsageEvent(input: {
  spaceId: string;
  projectId: string;
  runId: string;
  modelId: string;
  tokens: number;
  costCredits: number;
  rateCardVersion: string;
  payer: ProjectLlmPayer;
}): Record<string, unknown> {
  const provider = input.modelId.startsWith("@cf/") ? "cloudflare"
    : input.modelId.startsWith("claude-") ? "anthropic"
      : input.modelId.startsWith("gemini") ? "google"
        : input.modelId.includes("/") ? input.modelId.split("/")[0] ?? "unknown" : "unknown";
  return {
    event_type: "project_llm_tokens", quantity: input.tokens, unit: "tokens", schema_version: 2,
    idempotency_key: `run:${input.runId}:project-llm`,
    space_id: input.spaceId, project_id: input.projectId, run_id: input.runId,
    provider, model_id: input.modelId, cost_credits: input.costCredits,
    rate_card_version: input.rateCardVersion, payer_kind: input.payer, decision: "allowed",
  };
}
