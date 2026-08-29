/**
 * Billing provider selection (spec Appendix H). Lemon Squeezy is primary and is the ONLY
 * PLATFORM provider (item 45 — Naelao's own plan/store custody). The former Stripe Connect
 * Wallet Connect rail has been removed entirely — every business's own revenue custody now runs
 * through the Whop sub-merchant wallet model (`./whop.ts`), which is not a `BillingProvider`
 * (see that file's header).
 */

import type { BillingProvider, BillingProviderEnv } from "./types";
import { LemonSqueezyProvider } from "./lemon-squeezy";

export * from "./types";
export {
  LemonSqueezyProvider,
  lsListStores,
  lsCreateWebhook,
  lsDeleteWebhook,
} from "./lemon-squeezy";
export type { LsStoreSummary } from "./lemon-squeezy";
export {
  createSubMerchant,
  getCompanyStatus,
  createSubMerchantCheckout,
  createWithdrawal,
  transferPlatformFee,
  verifyWhopWebhook,
  parseWhopWalletEvent,
} from "./whop";
export type {
  WhopSubMerchant,
  WhopCompanyStatus,
  WhopCheckoutParams,
  WhopWithdrawal,
  WhopWalletEvent,
} from "./whop";
export {
  createOrGetAccessPass,
  createWhopOAuthPlan,
  createWhopOAuthCheckoutLink,
  createWhopOAuthCheckout,
} from "./whop-oauth-checkout";
export type { WhopOAuthPlanParams, WhopOAuthCheckoutParams } from "./whop-oauth-checkout";
export {
  createWhopPlatformPlanCheckout,
  WHOP_CUSTOMER_ORDERS_URL,
  verifyWhopPlatformPlanWebhook,
  parseWhopPlatformPlanEvent,
} from "./whop-platform-plan";
export type { WhopPlatformPlanCheckoutParams } from "./whop-platform-plan";

/** Resolve the active PLATFORM billing provider from env (always Lemon Squeezy — item 45). */
export function selectBillingProvider(env: BillingProviderEnv): BillingProvider {
  return new LemonSqueezyProvider(env);
}
