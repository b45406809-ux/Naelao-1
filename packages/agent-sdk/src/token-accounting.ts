/** Cheap streaming estimate. Provider usage remains the authoritative billing source. */
export const estimateTextTokens = (text: string): number => Math.ceil(text.length / 3.85);
/** Highest plausible combined usage report for one model call; current provider contexts are far below this. */
export const MAX_PROVIDER_USAGE_TOKENS = 10_000_000;
export interface ProviderTokenUsage { input_tokens: number; output_tokens: number }
export function validProviderUsage(value: unknown): ProviderTokenUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const usage = value as Record<string, unknown>;
    const input = usage.input_tokens, output = usage.output_tokens;
    if (typeof input !== "number" || typeof output !== "number" || !Number.isSafeInteger(input) || !Number.isSafeInteger(output)
      || input < 0 || output < 0 || input + output > MAX_PROVIDER_USAGE_TOKENS) return undefined;
    return { input_tokens: input, output_tokens: output };
  } catch { return undefined; }
}
