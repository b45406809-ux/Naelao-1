import { computeTokenCostMicro } from "./index.js";

/** The canonical monetary unit. One credit is exactly one US cent. */
export const CREDITS_PER_USD = 100;

export type ResourceType =
  | "llm_tokens"
  | "isolate_run"
  | "workflow_step"
  | "browser_scrape"
  | "chromium_snapshot"
  | "container_hour"
  | "voice_minute";

export interface ResourceMetadata {
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
  byok?: boolean;
}

function quantity(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError("quantity must be a finite non-negative number");
  return value;
}

/** Provider cost plus the platform's 15% operating margin, rounded up to whole credits. */
export function tokensToCredits(input: number, output: number, model: string, byok = false): number {
  quantity(input);
  quantity(output);
  if (byok || (input === 0 && output === 0)) return 0;
  const providerCostMicros = computeTokenCostMicro(input, output, model);
  return Math.max(1, Math.ceil(providerCostMicros * 1.15 * CREDITS_PER_USD / 1_000_000));
}

/** Settle a dynamic catalog model from its verified per-token USD prices. Callers must only pass
 * fresh provider evidence; values are bounded here as a second guard against malformed metadata. */
export function tokensToCreditsAtPrice(input: number, output: number, inputUsdPerToken: number, outputUsdPerToken: number): number {
  quantity(input);
  quantity(output);
  if (!Number.isFinite(inputUsdPerToken) || inputUsdPerToken < 0 || inputUsdPerToken > 1
    || !Number.isFinite(outputUsdPerToken) || outputUsdPerToken < 0 || outputUsdPerToken > 1) {
    throw new RangeError("token prices must be finite non-negative USD/token values at most 1");
  }
  if (input === 0 && output === 0) return 0;
  const providerCostMicros = Math.ceil((input * inputUsdPerToken + output * outputUsdPerToken) * 1_000_000);
  return Math.max(1, Math.ceil(providerCostMicros * 1.15 * CREDITS_PER_USD / 1_000_000));
}

/**
 * Conservative pre-execution request estimate. The UTF-8 size of the serialized prompt/tools
 * body is used as an upper-bound proxy for input tokens; this is deliberately an estimate, never
 * a settlement value. `maxOutputTokens` comes from the exact outbound request cap. Dynamic
 * catalogs must supply the fresh prices already validated by the caller.
 */
export function estimateRequestCostCredits(
  serializedRequestBytes: number,
  maxOutputTokens: number,
  model: string,
  pricing?: { inputUsdPerToken: number; outputUsdPerToken: number },
): { estimatedInputTokens: number; reservedOutputTokens: number; estimatedCredits: number; method: "utf8_bytes_plus_output_cap" } {
  if (!Number.isSafeInteger(serializedRequestBytes) || serializedRequestBytes < 0 || serializedRequestBytes > 8 * 1024 * 1024) throw new RangeError("serializedRequestBytes must be between 0 and 8 MiB");
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 0 || maxOutputTokens > 200_000) throw new RangeError("maxOutputTokens must be between 0 and 200000");
  const estimatedInputTokens = serializedRequestBytes;
  const estimatedCredits = pricing
    ? tokensToCreditsAtPrice(estimatedInputTokens, maxOutputTokens, pricing.inputUsdPerToken, pricing.outputUsdPerToken)
    : tokensToCredits(estimatedInputTokens, maxOutputTokens, model);
  return { estimatedInputTokens, reservedOutputTokens: maxOutputTokens, estimatedCredits, method: "utf8_bytes_plus_output_cap" };
}

/** Single authoritative conversion table for every metered runtime resource. */
export function calculateResourceCredits(
  resourceType: ResourceType,
  rawQuantity: number,
  metadata: ResourceMetadata = {},
): number {
  const amount = quantity(rawQuantity);
  if (amount === 0) return 0;
  switch (resourceType) {
    case "llm_tokens":
      return tokensToCredits(metadata.inputTokens ?? amount, metadata.outputTokens ?? 0, metadata.model ?? "claude-sonnet-4-6", metadata.byok);
    case "isolate_run": return Math.ceil(amount / 100);
    case "workflow_step": return Math.ceil(amount / 20);
    case "browser_scrape": return Math.ceil(amount / 10);
    case "chromium_snapshot": return Math.ceil(amount);
    case "container_hour": return Math.ceil(amount * 5);
    case "voice_minute": return Math.ceil(amount * 4);
  }
}

export const ACTIVE_PHONE_LINE_MONTHLY_CREDITS = 200;

export type InfraResourceType = "isolate" | "container" | "workflow_step";

/** Back-compatible duration adapter that still settles via the canonical resource table. */
export function infraTimeToCredits(resourceType: InfraResourceType, durationMs: number): number {
  quantity(durationMs);
  if (durationMs === 0 && resourceType !== "workflow_step") return 0;
  if (resourceType === "workflow_step") return calculateResourceCredits("workflow_step", 1);
  if (resourceType === "container") return calculateResourceCredits("container_hour", durationMs / 3_600_000);
  return calculateResourceCredits("isolate_run", 1);
}
