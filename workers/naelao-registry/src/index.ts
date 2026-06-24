import { Hono } from 'hono';
import { verifyJWT } from '../../naelao-auth/src/jwt';

export { SpaceTypeRegistryDO } from './SpaceTypeRegistryDO';
export { AppRegistryDO } from './AppRegistryDO';
export { WorkflowRegistryDO } from './WorkflowRegistryDO';

interface Env {
  NAELAO_CONFIG_KV: KVNamespace;
  NAELAO_CIRCUIT_KV: KVNamespace;
  NAELAO_SPACE_DO: DurableObjectNamespace;
  NAELAO_ANALYTICS: AnalyticsEngineDataset;
  NAELAO_JWT_SECRET: string;
  SpaceTypeRegistryDO: DurableObjectNamespace;
  AppRegistryDO: DurableObjectNamespace;
  WorkflowRegistryDO: DurableObjectNamespace;
}

function appRegistry(env: Env) {
  return env.AppRegistryDO.get(env.AppRegistryDO.idFromName('global'));
}
function spaceTypeRegistry(env: Env) {
  return env.SpaceTypeRegistryDO.get(env.SpaceTypeRegistryDO.idFromName('global'));
}
function workflowRegistry(env: Env, spaceId: string) {
  return env.WorkflowRegistryDO.get(env.WorkflowRegistryDO.idFromName('workflows:' + spaceId));
}

async function requireAuth(c: { req: { header: (h: string) => string | undefined }; json: (...args: unknown[]) => unknown; env: Env }): Promise<{ sub: string; spaceId: string; role: string } | null> {
  const token = (c.req.header('Authorization') ?? '').replace('Bearer ', '');
  if (!token) return null;
  try {
    return await verifyJWT(token, c.env.NAELAO_JWT_SECRET) as { sub: string; spaceId: string; role: string };
  } catch {
    return null;
  }
}

const app = new Hono<{ Bindings: Env }>();

app.use('*', async (c, next) => {
  const jwt = await requireAuth(c as never);
  if (!jwt) return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing token' } }, 401);
  c.set('jwt' as never, jwt);
  await next();
});

app.get('/v1/registry/apps', async (c) => {
  return appRegistry(c.env).fetch(new Request('http://do/apps'));
});

app.post('/v1/registry/apps', async (c) => {
  const body = await c.req.json();
  return appRegistry(c.env).fetch(new Request('http://do/apps/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
});

app.post('/v1/registry/apps/:id/install', async (c) => {
  const body = await c.req.json();
  return appRegistry(c.env).fetch(new Request('http://do/apps/' + c.req.param('id') + '/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
});

app.get('/v1/registry/space-types/:id', async (c) => {
  const id = c.req.param('id');
  const cacheKey = 'space-type-manifest:' + id;
  const cached = await c.env.NAELAO_CONFIG_KV.get(cacheKey);
  if (cached) return c.json(JSON.parse(cached));
  const resp = await spaceTypeRegistry(c.env).fetch(new Request('http://do/types/' + id));
  if (resp.ok) {
    const data = await resp.text();
    await c.env.NAELAO_CONFIG_KV.put(cacheKey, data, { expirationTtl: 3600 });
    return new Response(data, { headers: { 'Content-Type': 'application/json' } });
  }
  return resp;
});

app.post('/v1/registry/workflows', async (c) => {
  const body = await c.req.json<{ spaceId: string }>();
  return workflowRegistry(c.env, body.spaceId).fetch(new Request('http://do/workflows/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
});

app.get('/v1/registry/workflows/:spaceId', async (c) => {
  const spaceId = c.req.param('spaceId');
  return workflowRegistry(c.env, spaceId).fetch(new Request('http://do/workflows/' + spaceId));
});

app.post('/v1/registry/canary/process', async (c) => {
  const jwt = c.get('jwt' as never) as { role: string };
  if (jwt.role !== 'admin' && jwt.role !== 'owner') {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Admin only' } }, 403);
  }
  return spaceTypeRegistry(c.env).fetch(new Request('http://do/canary/process', { method: 'POST' }));
});

export default { fetch: app.fetch };
