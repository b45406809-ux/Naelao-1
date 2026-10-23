/**
 * Billing provider selection (spec Appendix H). Lemon Squeezy is primary and is the ONLY
 * PLATFORM provider (item 45 — Naelao's own plan/store custody). Whop remains available only
 * for Naelao's own platform plan checkout; customer app connections use the generic MCP connector
 * directory and do not participate in platform billing.
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
  createWhopPlatformPlanCheckout,
  WHOP_CUSTOMER_ORDERS_URL,
  verifyWhopPlatformPlanWebhook,
  parseWhopPlatformPlanEvent,
} from "./whop-platform-plan.js";
export type { WhopPlatformPlanCheckoutParams } from "./whop-platform-plan.js";

/** Resolve the active PLATFORM billing provider from env (always Lemon Squeezy — item 45). */
export function selectBillingProvider(env: BillingProviderEnv): BillingProvider {
  return new LemonSqueezyProvider(env);
}
