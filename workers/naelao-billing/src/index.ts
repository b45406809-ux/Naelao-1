import { Hono } from 'hono';
import { createBillingProvider } from '@naelao/billing-providers';
import { verifyJWT } from '../../naelao-auth/src/jwt';
import { grantCredits, creditsForVariant, revokeCredits } from './credits';

interface Env {
  NAELAO_SPACE_DO: DurableObjectNamespace;
  NAELAO_WALLET_DO: DurableObjectNamespace;
  NAELAO_CONFIG_KV: KVNamespace;
  NAELAO_CIRCUIT_KV: KVNamespace;
  NAELAO_NOTIFICATIONS_QUEUE: Queue;
  NAELAO_ANALYTICS: AnalyticsEngineDataset;
  BILLING_PROVIDER: string;
  LEMON_SQUEEZY_API_KEY: string;
  LEMON_SQUEEZY_WEBHOOK_SECRET: string;
  LEMON_SQUEEZY_STORE_ID_PROD: string;
  LEMON_SQUEEZY_STORE_ID_TEST: string;
  LEMON_SQUEEZY_VARIANT_CREDITS: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  ENVIRONMENT: string;
  PLATFORM_DAILY_CREDIT_CEILING_USD: string;
}

function spaceDOStub(env: Env, spaceId: string) {
  return env.NAELAO_SPACE_DO.get(env.NAELAO_SPACE_DO.idFromName('space:' + spaceId));
}

const app = new Hono<{ Bindings: Env }>();

app.post('/v1/billing/webhook', async (c) => {
  const rawBody = await c.req.text();
  const provider = createBillingProvider(c.env as never);

  const webhookSecret = c.env.BILLING_PROVIDER === 'stripe'
    ? (c.env.STRIPE_WEBHOOK_SECRET ?? '')
    : c.env.LEMON_SQUEEZY_WEBHOOK_SECRET;

  const valid = await provider.verifyWebhook(rawBody, c.req.raw.headers, webhookSecret);
  if (!valid) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid signature' } }, 401);
  }

  const event = provider.parseWebhookEvent(JSON.parse(rawBody) as Record<string, unknown>);

  const eventKey = 'billing-event:' + c.env.BILLING_PROVIDER + ':' + event.rawEventId;
  if (await c.env.NAELAO_CONFIG_KV.get(eventKey)) {
    return c.json({ received: true });
  }
  await c.env.NAELAO_CONFIG_KV.put(eventKey, '1', { expirationTtl: 86400 * 7 });

  const stub = event.spaceId ? spaceDOStub(c.env, event.spaceId) : null;

  switch (event.type) {
    case 'payment.success': {
      if (!event.spaceId) break;
      const credits = await creditsForVariant(event.variantOrPriceId ?? '', event.amountCents, c.env);
      await grantCredits(event.spaceId, credits, 'payment', event.rawEventId, c.env);
      break;
    }
    case 'payment.failed':
      if (stub && event.spaceId) {
        await stub.fetch(new Request('http://space/billing/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'payment_failed' }),
        }));
        await c.env.NAELAO_NOTIFICATIONS_QUEUE.send({
          id: event.rawEventId,
          type: 'payment_failed',
          spaceId: event.spaceId,
          data: {},
        });
      }
      break;
    case 'subscription.created':
      if (stub) {
        await stub.fetch(new Request('http://space/billing/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            subscriptionId: event.subscriptionId,
            portalUrl: event.portalUrl,
            status: 'active',
            provider: c.env.BILLING_PROVIDER,
          }),
        }));
      }
      break;
    case 'subscription.cancelled':
      if (stub) {
        await stub.fetch(new Request('http://space/billing/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'cancelled' }),
        }));
      }
      break;
    case 'subscription.paused':
      if (stub && event.spaceId) {
        await stub.fetch(new Request('http://space/billing/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'paused' }),
        }));
        await c.env.NAELAO_NOTIFICATIONS_QUEUE.send({
          id: event.rawEventId,
          type: 'subscription_paused',
          spaceId: event.spaceId,
          data: {},
        });
      }
      break;
    case 'subscription.resumed':
      if (stub) {
        await stub.fetch(new Request('http://space/billing/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'active' }),
        }));
      }
      break;
    case 'refund.issued':
      if (event.spaceId) {
        const refundCredits = await creditsForVariant(event.variantOrPriceId ?? '', event.amountCents, c.env);
        await revokeCredits(event.spaceId, refundCredits, 'refund', c.env);
      }
      break;
  }

  return c.json({ received: true });
});

app.post('/v1/billing/checkout', async (c) => {
  let jwt: { sub: string; spaceId: string };
  try {
    jwt = await verifyJWT(c.req.header('Authorization')?.slice(7) ?? '', c.env.NAELAO_JWT_SECRET) as typeof jwt;
  } catch {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid token' } }, 401);
  }

  const { planVariantOrPriceId, successUrl, cancelUrl } = await c.req.json<{
    planVariantOrPriceId: string; successUrl: string; cancelUrl?: string;
  }>();

  const provider = createBillingProvider(c.env as never);
  const url = await provider.createCheckout({
    planVariantOrPriceId,
    spaceId: jwt.spaceId,
    userId: jwt.sub,
    successUrl,
    cancelUrl,
    storeId: c.env.ENVIRONMENT === 'production'
      ? c.env.LEMON_SQUEEZY_STORE_ID_PROD
      : c.env.LEMON_SQUEEZY_STORE_ID_TEST,
  });

  return c.json({ data: { url } });
});

app.get('/v1/billing/portal', async (c) => {
  let jwt: { sub: string; spaceId: string };
  try {
    jwt = await verifyJWT(c.req.header('Authorization')?.slice(7) ?? '', c.env.NAELAO_JWT_SECRET) as typeof jwt;
  } catch {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid token' } }, 401);
  }

  const stub = spaceDOStub(c.env, jwt.spaceId);
  const metaResp = await stub.fetch(new Request('http://space/billing/portal'));
  const data = await metaResp.json<{ url?: string }>();
  return c.json({ data: { url: data.url ?? null } });
});

app.get('/v1/billing/balance', async (c) => {
  let jwt: { sub: string; spaceId: string };
  try {
    jwt = await verifyJWT(c.req.header('Authorization')?.slice(7) ?? '', c.env.NAELAO_JWT_SECRET) as typeof jwt;
  } catch {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid token' } }, 401);
  }

  const stub = spaceDOStub(c.env, jwt.spaceId);
  const resp = await stub.fetch(new Request('http://space/credits/balance'));
  return resp;
});

export default { fetch: app.fetch };
