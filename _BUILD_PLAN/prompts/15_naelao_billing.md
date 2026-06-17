# Prompt: workers/naelao-billing/src/ (2 files)

---
## PASTE THIS ENTIRE BLOCK INTO YOUR FREE AI
---

Platform: Naelao = multi-tenant AI agent builder on Cloudflare Workers + Durable Objects. NO Node.js, NO PostgreSQL. Data in SpaceDO SQLite (this.ctx.storage.sql). Worker comms via Service Bindings. Routing via Hono. Auth via JWT HMAC-SHA256. Billing via Lemon Squeezy first, Stripe later via BillingProvider interface. Errors: { error: { code: 'SNAKE_CASE', message: 'text' } }. All routes prefixed /v1/. compatibility_date: 2025-01-01.

Generate TWO files for workers/naelao-billing/src/.

Env:
  NAELAO_SPACE_DO: DurableObjectNamespace
  NAELAO_WALLET_DO: DurableObjectNamespace
  NAELAO_CONFIG_KV: KVNamespace  (idempotency keys)
  NAELAO_NOTIFICATIONS_QUEUE: Queue
  NAELAO_ANALYTICS: AnalyticsEngineDataset
  BILLING_PROVIDER: 'lemon_squeezy' | 'stripe'
  LEMON_SQUEEZY_API_KEY: string
  LEMON_SQUEEZY_WEBHOOK_SECRET: string
  LEMON_SQUEEZY_STORE_ID_PROD: string
  LEMON_SQUEEZY_STORE_ID_TEST: string
  LEMON_SQUEEZY_VARIANT_CREDITS: string  (JSON map variantId -> credits)
  STRIPE_SECRET_KEY?: string
  ENVIRONMENT: string
  PLATFORM_DAILY_CREDIT_CEILING_USD: string

=== File 1: src/credits.ts ===

Credit grant/deduct logic using SpaceDO. All credit operations go through SpaceDO.

  async function grantCredits(spaceId: string, credits: number, reason: string, billingEventId: string, env: Env): Promise<void>
  // Check idempotency: call spaceDO /billing/event-check { eventId: billingEventId }
  // If already processed: return (don't grant twice) - CRITICAL G-G03 fix
  // Mark event: spaceDO /billing/event-mark { eventId: billingEventId }
  // Grant: spaceDO /credits/add { amount: credits; reason; billingEventId }

  async function creditsForVariant(variantOrPriceId: string, amountCents: number, env: Env): Promise<number>
  // Parse LEMON_SQUEEZY_VARIANT_CREDITS JSON
  // Look up by variantOrPriceId
  // If not found: log error to NAELAO_ANALYTICS, return 0
  // CRITICAL: log error if credits === 0 for a known payment (G-H08 fix)

  async function revokeCredits(spaceId: string, credits: number, reason: string, env: Env): Promise<void>
  // Used for refunds - deduct proportional credits via SpaceDO /credits/deduct

=== File 2: src/index.ts ===

Hono Worker. The webhook endpoint is PUBLIC (no auth middleware - auth via signature verification).

  import { createBillingProvider } from '@naelao/billing-providers'

Routes:
  POST /v1/billing/webhook
    // PUBLIC - naelao-router must whitelist this path (G-H13 fix)
    1. Read raw body as text (BEFORE parsing JSON)
    2. Verify signature using provider.verifyWebhook(rawBody, request.headers, secret)
       Return 401 if invalid
    3. IDEMPOTENCY CHECK (G-G03 fix):
       const eventKey = 'billing-event:' + provider + ':' + event.rawEventId
       if (await env.NAELAO_CONFIG_KV.get(eventKey)) return c.json({ received: true })
       await env.NAELAO_CONFIG_KV.put(eventKey, '1', { expirationTtl: 86400 * 7 })
    4. Route by event.type:
       'payment.success': grantCredits(event.spaceId, credits, ...)
       'payment.failed': spaceDO billing/update { status: 'payment_failed' }; notify builder
       'subscription.created': spaceDO billing/update { subscriptionId, portalUrl, status:'active', provider }
       'subscription.cancelled': spaceDO billing/update { status: 'cancelled' }
       'subscription.paused': spaceDO billing/update { status: 'paused' }  (G-H06 fix)
       'subscription.resumed': spaceDO billing/update { status: 'active' }
       'refund.issued': revokeCredits proportionally (G-H09 fix)

  POST /v1/billing/checkout
    // Requires auth JWT
    { planVariantOrPriceId: string; successUrl: string; cancelUrl?: string }
    -> Use BillingProvider.createCheckout()
    -> Return { url: string }

  GET /v1/billing/portal
    // Requires auth JWT
    -> Fetch billing_portal_url from SpaceDO
    -> For LS: return stored URL (refreshed if >24h old via LS API)
    -> For Stripe: call portal session create
    -> Return { url: string }

  GET /v1/billing/balance
    // Requires auth JWT
    -> Fetch from SpaceDO /credits/balance
    -> Return { balance; dailySpent; monthlyBudget }

CRITICAL: billingProvider const must be created outside the handler to reuse:
  const billingProvider = createBillingProvider(env)

LS webhook secret from env.LEMON_SQUEEZY_WEBHOOK_SECRET.
Stripe webhook secret from env.STRIPE_WEBHOOK_SECRET.

