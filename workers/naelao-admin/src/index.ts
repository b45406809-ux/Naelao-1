import { Hono } from 'hono';
import { signJWT } from '../../naelao-auth/src/jwt';

interface Env {
  NAELAO_SPACE_DO: DurableObjectNamespace;
  NAELAO_CONFIG_KV: KVNamespace;
  NAELAO_CIRCUIT_KV: KVNamespace;
  NAELAO_ANALYTICS: AnalyticsEngineDataset;
  NAELAO_ANALYTICS_ACCOUNT_ID: string;
  NAELAO_JWT_SECRET: string;
  KILL_SWITCH_DO: DurableObjectNamespace;
}

const ALLOWED_EVENT_TYPES = new Set([
  'agent_run_complete', 'tool_execution', 'token_usage',
  'billing_payment_success', 'billing_payment_failed',
  'security_rate_limit', 'security_webhook_forged',
  'knowledge_indexed',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function spaceDOStub(env: Env, spaceId: string) {
  return env.NAELAO_SPACE_DO.get(env.NAELAO_SPACE_DO.idFromName('space:' + spaceId));
}

function killSwitchStub(env: Env) {
  return env.KILL_SWITCH_DO.get(env.KILL_SWITCH_DO.idFromName('global'));
}

const app = new Hono<{ Bindings: Env }>();

app.use('*', async (c, next) => {
  const email = c.req.header('CF-Access-Authenticated-User-Email');
  if (!email) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'CF Access required' } }, 401);
  }
  c.set('adminEmail' as never, email);
  await next();
});

app.get('/v1/admin/spaces', async (c) => {
  const cursor = c.req.query('cursor') ?? '';
  const limit = parseInt(c.req.query('limit') ?? '20');
  const listed = await c.env.NAELAO_CONFIG_KV.list({ prefix: 'space:', limit, cursor: cursor || undefined });
  const spaces = listed.keys.map(k => ({ spaceId: k.name.slice('space:'.length) }));
  return c.json({ data: { spaces, nextCursor: listed.cursor } });
});

app.get('/v1/admin/spaces/:id', async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid space ID' } }, 400);
  }
  const stub = spaceDOStub(c.env, id);
  const [metaResp, balResp] = await Promise.all([
    stub.fetch(new Request('http://space/meta')),
    stub.fetch(new Request('http://space/credits/balance')),
  ]);
  const meta = await metaResp.json();
  const balance = await balResp.json();
  return c.json({ data: { ...meta, ...balance } });
});

app.post('/v1/admin/spaces/:id/suspend', async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid space ID' } }, 400);
  }
  const { reason } = await c.req.json<{ reason: string }>();
  const stub = spaceDOStub(c.env, id);
  await stub.fetch(new Request('http://space/meta', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'suspended', suspendedReason: reason }),
  }));
  const adminEmail = c.get('adminEmail' as never) as string;
  c.env.NAELAO_ANALYTICS.writeDataPoint({
    blobs: ['admin_space_suspended', id, adminEmail, reason],
    doubles: [],
  });
  return c.json({ data: { ok: true } });
});

app.post('/v1/admin/spaces/:id/unsuspend', async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid space ID' } }, 400);
  }
  const stub = spaceDOStub(c.env, id);
  await stub.fetch(new Request('http://space/meta', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'active' }),
  }));
  return c.json({ data: { ok: true } });
});

app.get('/v1/admin/audit', async (c) => {
  const eventType = c.req.query('eventType');
  const spaceId = c.req.query('spaceId');

  if (eventType && !ALLOWED_EVENT_TYPES.has(eventType)) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid eventType' } }, 400);
  }
  if (spaceId && !UUID_RE.test(spaceId)) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid spaceId' } }, 400);
  }

  const prefix = eventType ? 'sec-event:' : 'sec-event:';
  const listed = await c.env.NAELAO_CONFIG_KV.list({ prefix, limit: 100 });
  const events = await Promise.all(
    listed.keys.map(k => c.env.NAELAO_CONFIG_KV.get(k.name, 'json'))
  );

  return c.json({ data: { events: events.filter(Boolean) } });
});

app.post('/v1/admin/impersonate', async (c) => {
  const adminEmail = c.get('adminEmail' as never) as string;
  const { targetUserId, scope, reason } = await c.req.json<{
    targetUserId: string; scope: string[]; reason: string;
  }>();

  const ALLOWED_SCOPES = new Set(['read:spaces', 'read:threads', 'read:agents']);
  for (const s of scope) {
    if (!ALLOWED_SCOPES.has(s)) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid scope: ' + s } }, 400);
    }
  }

  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = await signJWT(
    { sub: targetUserId, impersonatedBy: adminEmail, scope, exp },
    c.env.NAELAO_JWT_SECRET
  );

  c.env.NAELAO_ANALYTICS.writeDataPoint({
    blobs: ['admin_impersonation', adminEmail, targetUserId, reason],
    doubles: [],
  });

  return c.json({ data: { token, expiresAt: new Date(exp * 1000).toISOString() } });
});

app.post('/v1/admin/kill-switch/activate', async (c) => {
  const adminEmail = c.get('adminEmail' as never) as string;
  const { reason } = await c.req.json<{ reason: string }>();
  await c.env.NAELAO_CONFIG_KV.put('emergency:kill-all-agents', '1', { expirationTtl: 3600 });
  await killSwitchStub(c.env).fetch(new Request('http://ks/active', { method: 'POST' }));
  c.env.NAELAO_ANALYTICS.writeDataPoint({
    blobs: ['security_kill_switch_activated', adminEmail, reason],
    doubles: [],
  });
  return c.json({ data: { activated: true } });
});

app.post('/v1/admin/kill-switch/deactivate', async (c) => {
  const adminEmail = c.get('adminEmail' as never) as string;
  await c.env.NAELAO_CONFIG_KV.delete('emergency:kill-all-agents');
  await killSwitchStub(c.env).fetch(new Request('http://ks/active', { method: 'DELETE' }));
  c.env.NAELAO_ANALYTICS.writeDataPoint({
    blobs: ['security_kill_switch_deactivated', adminEmail],
    doubles: [],
  });
  return c.json({ data: { deactivated: true } });
});

app.get('/v1/admin/dlq-replay', async (c) => {
  return c.json({ data: { message: 'DLQ replay is handled by the naelao-sweeper queue consumer' } });
});

export default { fetch: app.fetch };
