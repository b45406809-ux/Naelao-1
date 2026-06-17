# Prompt 04c: packages/billing-providers/src/stripe.ts

---
## PASTE THIS ENTIRE BLOCK INTO YOUR FREE AI
---


**Platform context:** Naelao = multi-tenant AI agent builder on Cloudflare Workers + Durable Objects.
NO Node.js · NO PostgreSQL · NO Supabase. Data in SpaceDO SQLite. Worker comms via Service Bindings.
Routing via Hono. Auth via JWT (HMAC-SHA256). Billing via Lemon Squeezy (BillingProvider interface).
Errors always: { error: { code: 'SNAKE_CASE', message: 'text' } }. compatibility_date: "2025-01-01".

**Generate ONE file: `packages/billing-providers/src/stripe.ts`**

Implement `StripeProvider` that implements the `BillingProvider` interface from `./types.ts`.

Stripe is the **future** provider — implement it fully so it is ready when the time comes.

Key Stripe facts:
- Webhook signature: `Stripe-Signature` header format: `t=timestamp,v1=hexsig`
  - Verify: HMAC-SHA256(secret, `timestamp.rawBody`) and compare with constant-time equality
  - Reject if `|Date.now()/1000 - timestamp| > 300` (5 minute tolerance)
- Amounts are already integers in cents (no parsing needed)
- spaceId resolution (try in order): `invoice.metadata?.spaceId` → `invoice.subscription_details?.metadata?.spaceId` → fetch subscription from Stripe API

Event name → NormalizedEventType mapping:
```
checkout.session.completed        → payment.success
invoice.payment_succeeded         → payment.success
invoice.payment_failed            → payment.failed
customer.subscription.created     → subscription.created
customer.subscription.updated     → subscription.updated
customer.subscription.deleted     → subscription.cancelled
charge.refunded                   → refund.issued
```

`createCheckout` uses `stripe.checkout.sessions.create()` — stub: throw `Error('stripe not configured')` if `STRIPE_SECRET_KEY` is missing.

Customer portal: `stripe.billingPortal.sessions.create({ customer: customerId, return_url: ... })`.

Generate a complete, production-ready implementation. Do NOT add TODO comments.
