/** Cheap streaming estimate. Provider usage remains the authoritative billing source. */
export const estimateTextTokens = (text: string): number => Math.ceil(text.length / 3.85);
export interface ProviderTokenUsage { input_tokens: number; output_tokens: number }
export function validProviderUsage(value: unknown): ProviderTokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const input = usage.input_tokens, output = usage.output_tokens;
  if (typeof input !== "number" || typeof output !== "number" || !Number.isSafeInteger(input) || !Number.isSafeInteger(output) || input < 0 || output < 0) return undefined;
  return { input_tokens: input, output_tokens: output };
}
