import { Hono } from 'hono';
import { encryptCredential, decryptCredential } from './encrypt';
import { verifyInternalToken } from '../../naelao-auth/src/jwt';

interface Env {
  NAELAO_MCP_MASTER_KEY: string;
  NAELAO_CONFIG_KV: KVNamespace;
  NAELAO_JWT_SECRET: string;
  NAELAO_ANALYTICS: AnalyticsEngineDataset;
}

const app = new Hono<{ Bindings: Env }>();

async function verifyInternalAuth(c: Parameters<Parameters<typeof app.use>[1]>[0], env: Env): Promise<{ spaceId: string; agentId: string } | null> {
  const token = c.req.header('X-Internal-Token') ?? '';
  if (!token) return null;
  try {
    const claims = await verifyInternalToken(token, env.NAELAO_JWT_SECRET);
    if (typeof claims['spaceId'] !== 'string') return null;
    return { spaceId: claims['spaceId'] as string, agentId: claims['agentId'] as string ?? '' };
  } catch {
    return null;
  }
}

app.post('/v1/credentials/:spaceId/set', async (c) => {
  const urlSpaceId = c.req.param('spaceId');
  const claims = await verifyInternalAuth(c, c.env);
  if (!claims || claims.spaceId !== urlSpaceId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid token' } }, 401);
  }

  const { key, value, description } = await c.req.json<{ key: string; value: string; description?: string }>();
  const encrypted = await encryptCredential(value, c.env.NAELAO_MCP_MASTER_KEY, urlSpaceId);
  const kvKey = `cred:${urlSpaceId}:${key}`;
  await c.env.NAELAO_CONFIG_KV.put(kvKey, JSON.stringify({ encryptedValue: encrypted, description: description ?? '', updatedAt: new Date().toISOString() }));

  return c.json({ data: { ok: true } });
});

app.get('/v1/credentials/:spaceId/list', async (c) => {
  const urlSpaceId = c.req.param('spaceId');
  const claims = await verifyInternalAuth(c, c.env);
  if (!claims || claims.spaceId !== urlSpaceId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid token' } }, 401);
  }

  const prefix = `cred:${urlSpaceId}:`;
  const listed = await c.env.NAELAO_CONFIG_KV.list({ prefix });
  const keys = await Promise.all(
    listed.keys.map(async (k) => {
      const raw = await c.env.NAELAO_CONFIG_KV.get(k.name);
      if (!raw) return null;
      const data = JSON.parse(raw) as { description: string; updatedAt: string };
      return { key: k.name.slice(prefix.length), description: data.description, updatedAt: data.updatedAt };
    })
  );

  return c.json({ data: { keys: keys.filter(Boolean) } });
});

app.post('/v1/credentials/:spaceId/get', async (c) => {
  const urlSpaceId = c.req.param('spaceId');
  const claims = await verifyInternalAuth(c, c.env);
  if (!claims || claims.spaceId !== urlSpaceId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid token' } }, 401);
  }

  const { key } = await c.req.json<{ key: string }>();
  const raw = await c.env.NAELAO_CONFIG_KV.get(`cred:${urlSpaceId}:${key}`);
  if (!raw) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Credential not found' } }, 404);
  }

  const { encryptedValue } = JSON.parse(raw) as { encryptedValue: string };
  const value = await decryptCredential(encryptedValue, c.env.NAELAO_MCP_MASTER_KEY, urlSpaceId);

  c.env.NAELAO_ANALYTICS.writeDataPoint({ blobs: ['credential_access', urlSpaceId, key, claims.agentId] });

  return c.json({ data: { value } });
});

app.delete('/v1/credentials/:spaceId/:key', async (c) => {
  const urlSpaceId = c.req.param('spaceId');
  const key = c.req.param('key');
  const claims = await verifyInternalAuth(c, c.env);
  if (!claims || claims.spaceId !== urlSpaceId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid token' } }, 401);
  }

  await c.env.NAELAO_CONFIG_KV.delete(`cred:${urlSpaceId}:${key}`);
  return c.json({ data: { ok: true } });
});

app.post('/v1/credentials/:spaceId/rotate-key', async (c) => {
  const urlSpaceId = c.req.param('spaceId');
  const claims = await verifyInternalAuth(c, c.env);
  if (!claims || claims.spaceId !== urlSpaceId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid token' } }, 401);
  }

  const prefix = `cred:${urlSpaceId}:`;
  const listed = await c.env.NAELAO_CONFIG_KV.list({ prefix });
  let rotated = 0;

  for (const k of listed.keys) {
    const raw = await c.env.NAELAO_CONFIG_KV.get(k.name);
    if (!raw) continue;
    const data = JSON.parse(raw) as { encryptedValue: string; description: string; updatedAt: string };
    try {
      const plaintext = await decryptCredential(data.encryptedValue, c.env.NAELAO_MCP_MASTER_KEY, urlSpaceId);
      const reEncrypted = await encryptCredential(plaintext, c.env.NAELAO_MCP_MASTER_KEY, urlSpaceId);
      await c.env.NAELAO_CONFIG_KV.put(k.name, JSON.stringify({ ...data, encryptedValue: reEncrypted, updatedAt: new Date().toISOString() }));
      rotated++;
    } catch {
      // skip failed credential
    }
  }

  return c.json({ data: { ok: true, rotated } });
});

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
};
