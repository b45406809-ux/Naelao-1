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
