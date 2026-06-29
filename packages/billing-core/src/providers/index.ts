/**
 * Billing provider selection (spec Appendix H). Lemon Squeezy is primary; Stripe is a
 * future addition selected by BILLING_PROVIDER=stripe. The Stripe provider is intentionally
 * not implemented yet (the existing stripe.ts metering helpers remain for usage billing);
 * selecting it throws so we fail loudly rather than silently mis-bill.
 */

import type { BillingProvider, BillingProviderEnv } from "./types.js";
import { LemonSqueezyProvider } from "./lemon-squeezy.js";

export * from "./types.js";
export { LemonSqueezyProvider } from "./lemon-squeezy.js";

/** Resolve the active billing provider from env (defaults to Lemon Squeezy). */
export function selectBillingProvider(env: BillingProviderEnv): BillingProvider {
  if (env.BILLING_PROVIDER === "stripe") {
    throw new Error(
      "Stripe billing provider is a future addition (spec Appendix H). Set BILLING_PROVIDER=lemon_squeezy."
    );
  }
  return new LemonSqueezyProvider(env);
}
