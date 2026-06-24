import { LemonSqueezyProvider } from './lemon-squeezy';
import { StripeProvider } from './stripe';
import type { BillingProvider, BillingProviderEnv } from './types';

export * from './types';
export { LemonSqueezyProvider } from './lemon-squeezy';
export { StripeProvider } from './stripe';

export function createBillingProvider(env: BillingProviderEnv): BillingProvider {
  switch (env.BILLING_PROVIDER) {
    case 'stripe':
      return new StripeProvider();
    case 'lemon_squeezy':
      return new LemonSqueezyProvider();
    default:
      throw new Error(`Unknown BILLING_PROVIDER: ${env.BILLING_PROVIDER}`);
  }
}
