export interface DecisionReservationForSettlement {
  status: string;
  model_id: string;
  max_tokens: number;
  max_credits: number;
  provider_generation_id?: string | null;
  provider_cost_usd?: number | null;
}

export interface DecisionUsageReceipt {
  generation_id: string;
  model_id: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  evidence_source: "openrouter_response" | "openrouter_generation_api";
}

const GENERATION_ID = /^gen-[A-Za-z0-9-]{1,124}$/;

/** Validate bounded, host-authenticated usage facts before any durable billing transition. */
export function validateDecisionUsageReceipt(prior: DecisionReservationForSettlement, receipt: DecisionUsageReceipt): { tokens: number; costCredits: number } | null {
  if (!receipt || !["held", "uncertain"].includes(prior.status) || !GENERATION_ID.test(receipt.generation_id) || receipt.model_id !== prior.model_id ||
      !["openrouter_response", "openrouter_generation_api"].includes(receipt.evidence_source) ||
      (prior.status === "uncertain" && receipt.evidence_source !== "openrouter_generation_api") ||
      (prior.provider_generation_id != null && prior.provider_generation_id !== receipt.generation_id) ||
      !Number.isSafeInteger(receipt.input_tokens) || receipt.input_tokens < 0 ||
      !Number.isSafeInteger(receipt.output_tokens) || receipt.output_tokens < 0 ||
      !Number.isFinite(receipt.cost_usd) || receipt.cost_usd < 0) return null;
  const tokens = receipt.input_tokens + receipt.output_tokens;
  const costCredits = Math.ceil(receipt.cost_usd * 10_000);
  if (!Number.isSafeInteger(tokens) || tokens > prior.max_tokens || !Number.isSafeInteger(costCredits) || costCredits > prior.max_credits) return null;
  return { tokens, costCredits };
}
