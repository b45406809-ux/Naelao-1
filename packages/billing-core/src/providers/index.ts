/**
 * Billing provider selection (spec Appendix H). Lemon Squeezy is primary and is the ONLY
 * PLATFORM provider (item 45 — Naelao's own plan/store custody). StripeProvider now exists,
 * but exclusively as the Wallet Connect connected-account rail (constructed per
 * payment_connections row, never from platform env) — so selecting BILLING_PROVIDER=stripe
 * for platform billing still fails loudly rather than silently mis-billing.
 */

import type { BillingProvider, BillingProviderEnv } from "./types.js";
import { LemonSqueezyProvider } from "./lemon-squeezy.js";

export * from "./types.js";
export {
  LemonSqueezyProvider,
  lsListStores,
  lsCreateWebhook,
  lsDeleteWebhook,
} from "./lemon-squeezy.js";
export type { LsStoreSummary } from "./lemon-squeezy.js";
export {
  StripeProvider,
  createExpressAccount,
  createAccountLink,
  getAccountStatus,
  stripeFormEncode,
} from "./stripe.js";
export type { StripeProviderOpts, StripeAccountStatus } from "./stripe.js";

/** Resolve the active PLATFORM billing provider from env (always Lemon Squeezy — item 45). */
export function selectBillingProvider(env: BillingProviderEnv): BillingProvider {
  if (env.BILLING_PROVIDER === "stripe") {
    throw new Error(
      "Stripe is not a platform billing provider (item 45: platform custody is Lemon Squeezy only). Stripe is available per-space via Wallet Connect payment_connections."
    );
  }
  return new LemonSqueezyProvider(env);
}
