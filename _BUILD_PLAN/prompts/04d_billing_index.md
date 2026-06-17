# Prompt 04d: packages/billing-providers/src/index.ts

---
## PASTE THIS ENTIRE BLOCK INTO YOUR FREE AI
---


**Platform context:** Naelao = multi-tenant AI agent builder on Cloudflare Workers + Durable Objects.
NO Node.js · NO PostgreSQL · NO Supabase. Data in SpaceDO SQLite. Worker comms via Service Bindings.
Routing via Hono. Auth via JWT (HMAC-SHA256). Billing via Lemon Squeezy (BillingProvider interface).
Errors always: { error: { code: 'SNAKE_CASE', message: 'text' } }. compatibility_date: "2025-01-01".

**Generate ONE file: `packages/billing-providers/src/index.ts`**

This is the factory that returns the correct BillingProvider at runtime.

```typescript
import { LemonSqueezyProvider } from './lemon-squeezy';
import { StripeProvider } from './stripe';
import type { BillingProvider, BillingProviderEnv } from './types';

export * from './types';

export function createBillingProvider(env: BillingProviderEnv): BillingProvider {
  switch (env.BILLING_PROVIDER) {
    case 'stripe':        return new StripeProvider();
    case 'lemon_squeezy': return new LemonSqueezyProvider();
    default:              throw new Error(`Unknown BILLING_PROVIDER: ${env.BILLING_PROVIDER}`);
  }
}
```

Also export the two classes directly. Keep it simple — this file is just a barrel export + factory.
