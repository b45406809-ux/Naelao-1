import { Hono } from 'hono';
import { verifyJWT } from '../../naelao-auth/src/jwt';
import { provisionSpaceType } from './provision';
import { deprovisionSpace } from './deprovision';

interface Env {
  NAELAO_SPACE_DO: DurableObjectNamespace;
  NAELAO_VECTORIZE: VectorizeIndex;
  NAELAO_WORKFLOW_R2: R2Bucket;
  NAELAO_WORKSPACE: R2Bucket;
  NAELAO_CONFIG_KV: KVNamespace;
  NAELAO_CIRCUIT_KV: KVNamespace;
  NAELAO_PORTAL_ROUTES: KVNamespace;
  NAELAO_ANALYTICS: AnalyticsEngineDataset;
  NAELAO_REGISTRY: Fetcher;
  NAELAO_JWT_SECRET: string;
}

const app = new Hono<{ Bindings: Env }>();

app.use('*', async (c, next) => {
  const token = (c.req.header('Authorization') ?? '').replace('Bearer ', '');
  if (!token) return c.json({ error: { code: 'UNAUTHORIZED', message: 'Missing token' } }, 401);
  try {
    const jwt = await verifyJWT(token, c.env.NAELAO_JWT_SECRET) as { role: string };
    if (jwt.role !== 'admin' && jwt.role !== 'owner') {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Admin only' } }, 403);
    }
  } catch {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid token' } }, 401);
  }
  await next();
});

app.post('/v1/provision/space-type', async (c) => {
  const { spaceId, typeId, version } = await c.req.json<{
    spaceId: string; typeId: string; version: string;
  }>();
  try {
    await provisionSpaceType(spaceId, typeId, version, c.env);
    return c.json({ data: { ok: true } });
  } catch (e) {
    return c.json({ error: { code: 'PROVISION_FAILED', message: String(e) } }, 500);
  }
});

app.post('/v1/deprovision/space', async (c) => {
  const { spaceId } = await c.req.json<{ spaceId: string }>();
  try {
    await deprovisionSpace(spaceId, c.env);
    return c.json({ data: { ok: true } });
  } catch (e) {
    return c.json({ error: { code: 'DEPROVISION_FAILED', message: String(e) } }, 500);
  }
});

export default { fetch: app.fetch };
