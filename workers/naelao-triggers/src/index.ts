import { Hono } from 'hono';
import { verifySignature } from './verify-signature';

interface Env {
  NAELAO_SPACE_DO: DurableObjectNamespace;
  NAELAO_CONFIG_KV: KVNamespace;
  NAELAO_CIRCUIT_KV: KVNamespace;
  NAELAO_WORKFLOW_DISPATCH: Queue;
  NAELAO_ANALYTICS: AnalyticsEngineDataset;
  NAELAO_JWT_SECRET: string;
  GITHUB_WEBHOOK_SECRET: string;
  LEMON_SQUEEZY_WEBHOOK_SECRET: string;
  STRIPE_WEBHOOK_SECRET?: string;
}

function extractEventType(provider: string, payload: unknown, headers: Headers): string {
  if (provider === 'github') {
    const event = headers.get('X-GitHub-Event') ?? 'unknown';
    const action = (payload as Record<string, unknown>)['action'] as string | undefined;
    return action ? event + '.' + action : event;
  }
  if (provider === 'lemon_squeezy') {
    return ((payload as Record<string, unknown>)['meta'] as Record<string, unknown> | undefined)?.['event_name'] as string ?? 'unknown';
  }
  if (provider === 'stripe') {
    return ((payload as Record<string, unknown>)['type'] as string | undefined) ?? 'unknown';
  }
  return 'unknown';
}

const app = new Hono<{ Bindings: Env }>();

app.post('/v1/webhooks/:provider/:spaceId', async (c) => {
  const provider = c.req.param('provider');
  const spaceId = c.req.param('spaceId');
  const rawBody = await c.req.text();

  const valid = await verifySignature(provider, rawBody, c.req.raw.headers, c.env);
  if (!valid) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid signature' } }, 401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    try {
      payload = Object.fromEntries(new URLSearchParams(rawBody));
    } catch {
      payload = {};
    }
  }

  const eventType = extractEventType(provider, payload, c.req.raw.headers);

  const spaceDO = c.env.NAELAO_SPACE_DO.get(c.env.NAELAO_SPACE_DO.idFromName('space:' + spaceId));
  let triggerCount = 0;

  try {
    const trigResp = await spaceDO.fetch(new Request(
      'http://space/triggers?provider=' + encodeURIComponent(provider) + '&eventType=' + encodeURIComponent(eventType)
    ));
    if (trigResp.ok) {
      const data = await trigResp.json<{ triggers: Array<{ workflowId: string }> }>();
      const triggers = data.triggers ?? [];
      triggerCount = triggers.length;
      await Promise.all(triggers.map(t =>
        c.env.NAELAO_WORKFLOW_DISPATCH.send({
          workflowId: t.workflowId,
          spaceId,
          triggeredBy: 'webhook',
          payload,
        })
      ));
    }
  } catch {
    // trigger lookup failed; still return 200
  }

  c.env.NAELAO_ANALYTICS.writeDataPoint({
    blobs: ['webhook_received', spaceId, provider, eventType],
    doubles: [triggerCount],
  });

  return c.json({ data: { received: true, triggers: triggerCount } });
});

export default { fetch: app.fetch };
