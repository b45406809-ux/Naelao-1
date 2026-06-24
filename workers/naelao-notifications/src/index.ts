type NotificationType =
  | 'subscription_paused' | 'subscription_cancelled' | 'payment_failed'
  | 'credits_low' | 'credits_exhausted' | 'agent_run_failed' | 'space_suspended'
  | 'finetune_complete' | 'finetune_failed';

interface NotificationPayload {
  id: string;
  type: NotificationType;
  spaceId: string;
  userId?: string;
  data: Record<string, unknown>;
}

interface Env {
  NAELAO_SPACE_DO: DurableObjectNamespace;
  NAELAO_CONFIG_KV: KVNamespace;
  NAELAO_CIRCUIT_KV: KVNamespace;
  NAELAO_ANALYTICS: AnalyticsEngineDataset;
}

async function sendPush(payload: NotificationPayload, env: Env): Promise<void> {
  const userId = payload.userId;
  if (!userId) return;

  const spaceDO = env.NAELAO_SPACE_DO.get(env.NAELAO_SPACE_DO.idFromName('space:' + payload.spaceId));
  const resp = await spaceDO.fetch(new Request('http://space/device-tokens?userId=' + encodeURIComponent(userId)));
  if (!resp.ok) return;
  const data = await resp.json<{ tokens?: string[] }>();
  const tokens = data.tokens ?? [];

  for (const token of tokens) {
    env.NAELAO_ANALYTICS.writeDataPoint({
      blobs: ['push_sent', payload.spaceId, payload.type, token],
      doubles: [],
    });
  }
}

function notificationTitle(type: NotificationType): string {
  const titles: Record<NotificationType, string> = {
    subscription_paused: 'Subscription Paused',
    subscription_cancelled: 'Subscription Cancelled',
    payment_failed: 'Payment Failed',
    credits_low: 'Credits Running Low',
    credits_exhausted: 'Credits Exhausted',
    agent_run_failed: 'Agent Run Failed',
    space_suspended: 'Space Suspended',
    finetune_complete: 'Fine-tuning Complete',
    finetune_failed: 'Fine-tuning Failed',
  };
  return titles[type];
}

async function handleNotification(payload: NotificationPayload, env: Env): Promise<void> {
  const idempKey = 'notif:' + payload.id;
  if (await env.NAELAO_CONFIG_KV.get(idempKey)) return;
  await env.NAELAO_CONFIG_KV.put(idempKey, '1', { expirationTtl: 86400 * 7 });

  await sendPush(payload, env);

  env.NAELAO_ANALYTICS.writeDataPoint({
    blobs: ['notification_sent', payload.spaceId, payload.type, notificationTitle(payload.type)],
    doubles: [],
  });
}

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
  },
};
