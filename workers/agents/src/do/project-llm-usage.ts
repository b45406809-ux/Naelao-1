export type ProjectLlmPayer = "platform" | "unknown";

function llmUsageEvent(eventType: "project_llm_tokens" | "llm_tokens", input: {
  spaceId: string;
  projectId?: string;
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
    event_type: eventType, quantity: input.tokens, unit: "tokens", schema_version: 2,
    idempotency_key: `run:${input.runId}:project-llm`,
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


export function channelConnectorCallUsageEvent(input: {
  spaceId: string;
  projectId: string;
  installationId: string;
  runId: string;
  connectorProvider: string;
  subjectHash: string;
  succeeded: boolean;
}): Record<string, unknown> {
  return {
    event_type: "connector_calls", quantity: 1, unit: "invocations", schema_version: 2,
    idempotency_key: `channel-delivery:${input.installationId}:${input.runId}`,
    space_id: input.spaceId, project_id: input.projectId, installation_id: input.installationId,
    run_id: input.runId, connector_provider: input.connectorProvider, subject_hash: input.subjectHash,
    payer_kind: "unknown", decision: input.succeeded ? "allowed" : "failed",
  };
}
