# Prompt: workers/naelao-notifications/src/index.ts

---
## PASTE THIS ENTIRE BLOCK INTO YOUR FREE AI
---

Naelao = multi-tenant AI agent builder on Cloudflare Workers + Durable Objects. NO Node.js, NO PostgreSQL. Data in SpaceDO SQLite. Service Bindings for Worker comms. Hono for routing. JWT auth. Errors: { error: { code: 'SNAKE_CASE', message: 'text' } }. All routes /v1/. compatibility_date: 2025-01-01.

Generate ONE file: workers/naelao-notifications/src/index.ts

Queue consumer worker for push and email notifications.

Env:
  NAELAO_SPACE_DO: DurableObjectNamespace
  NAELAO_CONFIG_KV: KVNamespace  (idempotency keys)
  NAELAO_ANALYTICS: AnalyticsEngineDataset

Notification payload types:
  type NotificationType = 'subscription_paused' | 'subscription_cancelled' | 'payment_failed'
    | 'credits_low' | 'credits_exhausted' | 'agent_run_failed' | 'space_suspended'
    | 'finetune_complete' | 'finetune_failed';

  interface NotificationPayload {
    id: string;       // idempotency key - should include Stripe/LS event ID if billing-related
    type: NotificationType;
    spaceId: string;
    userId?: string;
    data: Record<string, unknown>;
  }

Export default with queue handler:
CRITICAL (G-I14 fix): Promise.allSettled swallows errors — failed messages are silently ACKed.
MUST use per-message msg.ack() / msg.retry() to properly route failures to the DLQ:
  export default {
    async queue(batch: MessageBatch<NotificationPayload>, env: Env): Promise<void> {
      await Promise.allSettled(batch.messages.map(async (msg) => {
        try {
          await handleNotification(msg.body, env);
          msg.ack();
        } catch (err) {
          console.error('notification failed, will retry:', err);
          msg.retry();
        }
      }));
    }
  }

CRITICAL FIX (G-G21): Idempotency keys MUST have TTL:
  const idempKey = 'notif:' + payload.id;
  if (await env.NAELAO_CONFIG_KV.get(idempKey)) return;  // already sent
  await env.NAELAO_CONFIG_KV.put(idempKey, '1', { expirationTtl: 86400 * 7 });  // 7-day TTL

CRITICAL FIX (G-F16): sendPush MUST use correct Service Binding pattern for device tokens:
  // WRONG: await fetch(spaceDO.getActiveDeviceTokens(userId))  <- TypeError
  // CORRECT:
  const spaceDO = env.NAELAO_SPACE_DO.get(env.NAELAO_SPACE_DO.idFromName('space:' + spaceId));
  const resp = await spaceDO.fetch(new Request('http://space/device-tokens?userId=' + userId));
  const { tokens } = await resp.json();

For each notification type, send:
  - Web Push (if device tokens available): use Web Push API or CF Email Workers
  - Email: call CF Email Workers binding if available, else log to Analytics
  - Log notification event to NAELAO_ANALYTICS regardless

Handle notification_paused event from Lemon Squeezy (G-H06 fix): send 'subscription_paused' type.

