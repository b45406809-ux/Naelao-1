# Prompt 04b: packages/billing-providers/src/lemon-squeezy.ts

---
## PASTE THIS ENTIRE BLOCK INTO YOUR FREE AI
---


**Platform context:** Naelao = multi-tenant AI agent builder on Cloudflare Workers + Durable Objects.
NO Node.js · NO PostgreSQL · NO Supabase. Data in SpaceDO SQLite. Worker comms via Service Bindings.
Routing via Hono. Auth via JWT (HMAC-SHA256). Billing via Lemon Squeezy (BillingProvider interface).
Errors always: { error: { code: 'SNAKE_CASE', message: 'text' } }. compatibility_date: "2025-01-01".

**Generate ONE file: `packages/billing-providers/src/lemon-squeezy.ts`**

Implement `LemonSqueezyProvider` that implements the `BillingProvider` interface from `./types.ts`.

Key facts about Lemon Squeezy's API:
- Webhook signature: `X-Signature` header = hex-encoded HMAC-SHA256(secret, rawBody)
- Amount fields are **strings** in cents: `"2900"` = $29.00. ALWAYS use `parseInt()`, never parseFloat.
- spaceId lives in `event.meta.custom_data.spaceId` (orders) OR `event.data.attributes.custom_data.spaceId` (subscriptions)
- Checkout URL created via: `POST https://api.lemonsqueezy.com/v1/checkouts`
- Customer portal URL is in `event.data.attributes.urls.customer_portal` — store it at subscription_created time
- Store ID is integer: use STORE_ID_PROD when ENVIRONMENT === 'production', else STORE_ID_TEST

Event name → NormalizedEventType mapping:
```
order_created                → payment.success
order_refunded               → refund.issued
subscription_created         → subscription.created
subscription_updated         → subscription.updated
subscription_cancelled       → subscription.cancelled
subscription_paused          → subscription.paused
subscription_unpaused        → subscription.resumed
subscription_payment_success → payment.success
subscription_payment_failed  → payment.failed
subscription_payment_recovered → payment.success
```

`verifyWebhook` implementation:
```typescript
// Use Web Crypto API (available in CF Workers):
const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
  { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const expected = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
const expectedHex = [...new Uint8Array(expected)].map(b => b.toString(16).padStart(2,'0')).join('');
// Use timing-safe compare (implement manually — no timingSafeEqual in CF Workers):
// Compare char by char, accumulate XOR, check === 0
```

`createCheckout` must embed spaceId in custom_data:
```
checkout[custom][spaceId] = spaceId  (as query parameter on checkout URL)
AND in POST body: data.attributes.checkout_data.custom.spaceId = spaceId
```

`parseWebhookEvent` must handle ALL event names listed above. For unknown events, throw `Error('unknown_event_type: ' + eventName)`.

For `refund.issued`: compute proportional amount — if partial refund, amountCents = Math.ceil(totalCredits × refundFraction).

Generate the complete class with all methods.
