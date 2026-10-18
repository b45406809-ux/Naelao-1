import { tokensToCredits, tokensToCreditsAtPrice } from "@naelao/billing-core";

export type ExternalAnswerUsage = { input_tokens: number; output_tokens: number };
export type ExternalModelPricing = { inputUsdPerToken: number; outputUsdPerToken: number };

/** Calculate the charge for the restricted, direct-answer path. Reservations are the conservative
 * fallback when a provider omits usage; successful usage evidence always takes precedence. */
export function externalAnswerCredits(args: {
  usage?: ExternalAnswerUsage;
  model: string;
  pricing?: ExternalModelPricing;
  estimatedCredits: number;
}): number {
  if (!args.usage) return args.estimatedCredits;
  if (args.model.startsWith("openrouter/") && args.pricing) {
    return tokensToCreditsAtPrice(args.usage.input_tokens, args.usage.output_tokens,
      args.pricing.inputUsdPerToken, args.pricing.outputUsdPerToken);
  }
  return tokensToCredits(args.usage.input_tokens, args.usage.output_tokens, args.model);
}

/** Settle a successful direct-answer inference and prevent its reservation being settled twice. */
export async function settleExternalAnswerSpend(args: {
  reserved: boolean;
  credits: number;
  settle: (credits: number) => Promise<void>;
  markSettled: () => void;
}): Promise<void> {
  if (!args.reserved) return;
  await args.settle(args.credits);
  args.markSettled();
}

/** Release a reservation when the provider failed before returning a usable answer. */
export async function releaseExternalAnswerSpend(args: {
  reserved: boolean;
  settle: (credits: number) => Promise<void>;
  markSettled: () => void;
}): Promise<void> {
  await settleExternalAnswerSpend({ ...args, credits: 0 });
}
