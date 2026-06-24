import { Hono } from 'hono';
import { verifyJWT } from '../../naelao-auth/src/jwt';

export { SpaceDO } from './SpaceDO';
export { WalletDO } from './WalletDO';
export { ConcurrencyDO } from './ConcurrencyDO';
export { BuilderAccountDO } from './BuilderAccountDO';

interface Env {
  NAELAO_SPACE_DO: DurableObjectNamespace;
  NAELAO_WALLET_DO: DurableObjectNamespace;
  NAELAO_CONCURRENCY_DO: DurableObjectNamespace;
  NAELAO_BUILDER_DO: DurableObjectNamespace;
  NAELAO_CONFIG_KV: KVNamespace;
  NAELAO_ANALYTICS: AnalyticsEngineDataset;
  NAELAO_JWT_SECRET: string;
  ENVIRONMENT: string;
}

function getSpaceDO(spaceId: string, env: Env) {
  return env.NAELAO_SPACE_DO.get(env.NAELAO_SPACE_DO.idFromName('space:' + spaceId));
}

function getConcurrencyDO(userId: string, env: Env) {
  return env.NAELAO_CONCURRENCY_DO.get(env.NAELAO_CONCURRENCY_DO.idFromName('space-create-lock:' + userId));
}

const INTERNAL_TOKEN = 'x-internal-token';

function verifyInternal(request: Request): boolean {
  return request.headers.has(INTERNAL_TOKEN);
}

const app = new Hono<{ Bindings: Env }>();

app.use('/v1/*', async (c, next) => {
  const auth = c.req.header('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Token required' } }, 401);
  }
  try {
    const payload = await verifyJWT(auth.slice(7), c.env.NAELAO_JWT_SECRET);
    c.set('jwt' as never, payload as never);
  } catch {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid token' } }, 401);
  }
  await next();
});

app.post('/v1/spaces', async (c) => {
  const jwt = c.get('jwt' as never) as { sub: string; builderId: string };
  const body = await c.req.json<{ name: string; slug: string; spaceType?: string }>();

  const concurrencyDO = getConcurrencyDO(jwt.sub, c.env);
  const acquireResp = await concurrencyDO.fetch(
    new Request('http://do/acquire', { method: 'POST', body: JSON.stringify({ lockId: 'create:' + jwt.sub }) })
  );
  const { data: lockData } = await acquireResp.json<{ data: { granted: boolean } }>();
  if (!lockData.granted) {
    return c.json({ error: { code: 'CONFLICT', message: 'Space creation already in progress' } }, 409);
  }

  try {
    const spaceId = crypto.randomUUID();
    const spaceDO = getSpaceDO(spaceId, c.env);
    await spaceDO.fetch(new Request('http://space/init', {
      method: 'POST',
      body: JSON.stringify({ id: spaceId, rootSpaceId: spaceId, name: body.name, slug: body.slug, spaceType: body.spaceType, ownerId: jwt.sub }),
    }));

    await c.env.NAELAO_CONFIG_KV.put('space:' + spaceId, spaceId);

    return c.json({ data: { id: spaceId, name: body.name, slug: body.slug } });
  } finally {
    await concurrencyDO.fetch(
      new Request('http://do/release-lock', { method: 'POST', body: JSON.stringify({ lockId: 'create:' + jwt.sub }) })
    );
  }
});

app.get('/v1/spaces/:spaceId', async (c) => {
  const spaceId = c.req.param('spaceId');
  const spaceDO = getSpaceDO(spaceId, c.env);
  const resp = await spaceDO.fetch(new Request('http://space/meta'));
  return resp;
});

app.patch('/v1/spaces/:spaceId', async (c) => {
  const spaceId = c.req.param('spaceId');
  const body = await c.req.json();
  const spaceDO = getSpaceDO(spaceId, c.env);
  const resp = await spaceDO.fetch(new Request('http://space/billing/update', {
    method: 'POST',
    body: JSON.stringify(body),
  }));
  return resp;
});

app.delete('/v1/spaces/:spaceId', async (c) => {
  const spaceId = c.req.param('spaceId');
  const spaceDO = getSpaceDO(spaceId, c.env);
  await spaceDO.fetch(new Request('http://space/purge', { method: 'POST' }));
  await c.env.NAELAO_CONFIG_KV.delete('space:' + spaceId);
  return c.json({ data: { ok: true } });
});

app.get('/v1/spaces/:spaceId/members', async (c) => {
  const spaceId = c.req.param('spaceId');
  const spaceDO = getSpaceDO(spaceId, c.env);
  return spaceDO.fetch(new Request('http://space/members/list'));
});

app.post('/v1/spaces/:spaceId/members', async (c) => {
  const spaceId = c.req.param('spaceId');
  const body = await c.req.json<{ userId: string; role: string }>();
  const spaceDO = getSpaceDO(spaceId, c.env);
  return spaceDO.fetch(new Request('http://space/members/add', { method: 'POST', body: JSON.stringify(body) }));
});

app.delete('/v1/spaces/:spaceId/members/:userId', async (c) => {
  const spaceId = c.req.param('spaceId');
  const userId = c.req.param('userId');
  const spaceDO = getSpaceDO(spaceId, c.env);
  const resp = await spaceDO.fetch(new Request('http://space/members/remove', {
    method: 'POST',
    body: JSON.stringify({ userId }),
  }));
  await c.env.NAELAO_CONFIG_KV.put(`revoked:${userId}:${spaceId}`, String(Date.now()), { expirationTtl: 7200 });
  return resp;
});

app.patch('/v1/spaces/:spaceId/members/:userId', async (c) => {
  const spaceId = c.req.param('spaceId');
  const userId = c.req.param('userId');
  const { role } = await c.req.json<{ role: string }>();
  const spaceDO = getSpaceDO(spaceId, c.env);
  const resp = await spaceDO.fetch(new Request('http://space/members/role', {
    method: 'PATCH',
    body: JSON.stringify({ userId, role }),
  }));
  await c.env.NAELAO_CONFIG_KV.put(`revoked:${userId}:${spaceId}`, String(Date.now()), { expirationTtl: 7200 });
  return resp;
});

app.get('/v1/spaces/:spaceId/usage', async (c) => {
  const spaceId = c.req.param('spaceId');
  const spaceDO = getSpaceDO(spaceId, c.env);
  return spaceDO.fetch(new Request('http://space/credits/balance'));
});

// Internal routes (service-to-service only)
app.post('/internal/members/check', async (c) => {
  const { userId, spaceId } = await c.req.json<{ userId: string; spaceId: string }>();
  const spaceDO = getSpaceDO(spaceId, c.env);
  const resp = await spaceDO.fetch(new Request('http://space/members/check', {
    method: 'POST',
    body: JSON.stringify({ userId }),
  }));
  const data = await resp.json<{ data: { allowed: boolean; role?: string } }>();
  return c.json({ isMember: data.data.allowed, role: data.data.role });
});

app.get('/internal/agents/runs', async (c) => {
  const spaceId = c.req.query('spaceId') ?? '';
  const userId = c.req.query('userId') ?? '';
  const limit = c.req.query('limit') ?? '20';
  const cursor = c.req.query('cursor') ?? '';
  const spaceDO = getSpaceDO(spaceId, c.env);
  const qs = new URLSearchParams({ spaceId, userId, limit, ...(cursor ? { cursor } : {}) });
  return spaceDO.fetch(new Request('http://space/agents/runs/list?' + qs.toString()));
});

app.post('/internal/space-index/register', async (c) => {
  const { spaceId } = await c.req.json<{ spaceId: string }>();
  await c.env.NAELAO_CONFIG_KV.put('space:' + spaceId, spaceId);
  return c.json({ data: { ok: true } });
});

app.delete('/internal/space-index/deregister', async (c) => {
  const { spaceId } = await c.req.json<{ spaceId: string }>();
  await c.env.NAELAO_CONFIG_KV.delete('space:' + spaceId);
  return c.json({ data: { ok: true } });
});

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
};
