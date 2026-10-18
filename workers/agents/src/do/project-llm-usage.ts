export type ProjectLlmPayer = "space_wallet" | "unknown";
export type ConsumerLlmPayer = "consumer_credits";

function llmUsageEvent(eventType: "project_llm_tokens" | "llm_tokens", input: {
  spaceId: string;
  projectId?: string;
  runId: string;
  modelId: string;
  tokens: number;
  costCredits: number;
  rateCardVersion: string;
  payer: ProjectLlmPayer | ConsumerLlmPayer;
}): Record<string, unknown> {
  const provider = input.modelId.startsWith("@cf/") ? "cloudflare"
    : input.modelId.startsWith("claude-") ? "anthropic"
      : input.modelId.startsWith("gemini") ? "google"
        : input.modelId.includes("/") ? input.modelId.split("/")[0] ?? "unknown" : "unknown";
  return {
    event_type: eventType, quantity: input.tokens, unit: "tokens", schema_version: 2,
    idempotency_key: `run:${input.runId}:${eventType === "project_llm_tokens" ? "project-llm" : "consumer-llm"}`,
    space_id: input.spaceId, ...(input.projectId ? { project_id: input.projectId } : {}), run_id: input.runId,
    provider, model_id: input.modelId, cost_credits: input.costCredits,
    rate_card_version: input.rateCardVersion, payer_kind: input.payer, decision: "allowed",
  };
}

export function projectLlmUsageEvent(input: {
  spaceId: string; projectId: string; runId: string; modelId: string; tokens: number;
  costCredits: number; rateCardVersion: string; payer: ProjectLlmPayer;
}): Record<string, unknown> {
  return llmUsageEvent("project_llm_tokens", input);
}

export function consumerLlmUsageEvent(input: {
  spaceId: string; runId: string; modelId: string; tokens: number;
  costCredits: number; rateCardVersion: string;
}): Record<string, unknown> {
  return llmUsageEvent("llm_tokens", { ...input, payer: "consumer_credits" });
}
