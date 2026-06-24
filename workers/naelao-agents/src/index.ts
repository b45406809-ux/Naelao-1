import { Hono } from 'hono';
import { verifyJWT } from '../../naelao-auth/src/jwt';

export { NaelaoAgentDO } from './NaelaoAgentDO';
export { LocalTunnelDO } from './LocalTunnelDO';

interface Env {
  NAELAO_AGENT_DO: DurableObjectNamespace;
  NAELAO_CONCURRENCY_DO: DurableObjectNamespace;
  NAELAO_WALLET_DO: DurableObjectNamespace;
  NAELAO_SPACES: Fetcher;
  NAELAO_AUTH: Fetcher;
  NAELAO_CREDENTIALS: Fetcher;
  KV_SESSIONS: KVNamespace;
  NAELAO_CONFIG_KV: KVNamespace;
  NAELAO_CIRCUIT_KV: KVNamespace;
  NAELAO_JWT_SECRET: string;
  AGENT_RUN_TIMEOUT_MS: string;
}

interface JWTPayload {
  sub: string;
  spaceId: string;
  role: string;
  exp: number;
}

function agentStub(env: Env, runId: string) {
  return env.NAELAO_AGENT_DO.get(env.NAELAO_AGENT_DO.idFromName(runId));
}

function concurrencyStub(env: Env, spaceId: string) {
  return env.NAELAO_CONCURRENCY_DO.get(env.NAELAO_CONCURRENCY_DO.idFromName(spaceId));
}

async function extractJWT(req: Request, secret: string): Promise<JWTPayload> {
  const auth = req.headers.get('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) throw new Error('missing_token');
  return verifyJWT(token, secret) as Promise<JWTPayload>;
}

const app = new Hono<{ Bindings: Env }>();

app.use('*', async (c, next) => {
  const traceId = c.req.header('X-Trace-ID') ?? crypto.randomUUID();
  c.set('traceId' as never, traceId);
  c.header('X-Trace-ID', traceId);
  await next();
});

app.post('/agents/run/start', async (c) => {
  let jwt: JWTPayload;
  try {
    jwt = await extractJWT(c.req.raw, c.env.NAELAO_JWT_SECRET);
  } catch {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing token' } }, 401);
  }

  const { spaceId, nodeId, instructions, model } = await c.req.json<{
    spaceId: string; nodeId: string; instructions: string; model?: string;
  }>();

  const memberResp = await c.env.NAELAO_SPACES.fetch(new Request('http://spaces/internal/members/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: jwt.sub, spaceId }),
  }));
  const memberData = await memberResp.json<{ isMember: boolean }>();
  if (!memberData.isMember) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Not a space member' } }, 403);
  }

  const runId = crypto.randomUUID();

  const gate = concurrencyStub(c.env, spaceId);
  const gateResp = await gate.fetch(new Request('http://do/reserve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId, maxConcurrent: 3 }),
  }));
  if (gateResp.status === 429) {
    return c.json(
      { error: { code: 'TOO_MANY_REQUESTS', message: 'Concurrency limit reached' } },
      429,
      { 'Retry-After': '5' }
    );
  }

  const stub = agentStub(c.env, runId);
  await stub.fetch(new Request('http://do/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spaceId, nodeId, userId: jwt.sub, instructions, model, runId }),
  }));

  return c.json({ data: { runId, wsUrl: '/agents/run/' + runId + '/ws' } });
});

app.get('/agents/run/:runId/ws', async (c) => {
  const runId = c.req.param('runId');
  const url = new URL(c.req.url);
  const tokenParam = url.searchParams.get('token') ?? '';
  const authHeader = c.req.header('Authorization') ?? '';
  const token = tokenParam || (authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '');

  if (!token) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Missing token' } }, 401);
  }
  try {
    await verifyJWT(token, c.env.NAELAO_JWT_SECRET);
  } catch {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid token' } }, 401);
  }

  const stub = agentStub(c.env, runId);
  return stub.fetch(c.req.raw);
});

app.get('/agents/run/:runId/status', async (c) => {
  try {
    await extractJWT(c.req.raw, c.env.NAELAO_JWT_SECRET);
  } catch {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing token' } }, 401);
  }
  const runId = c.req.param('runId');
  const stub = agentStub(c.env, runId);
  return stub.fetch(new Request('http://do/status'));
});

app.post('/agents/run/:runId/cancel', async (c) => {
  let jwt: JWTPayload;
  try {
    jwt = await extractJWT(c.req.raw, c.env.NAELAO_JWT_SECRET);
  } catch {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing token' } }, 401);
  }
  const runId = c.req.param('runId');
  const stub = agentStub(c.env, runId);

  const statusResp = await stub.fetch(new Request('http://do/status'));
  const statusData = await statusResp.json<{ data: { userId?: string; space_id?: string } }>();
  if (statusData.data?.userId && statusData.data.userId !== jwt.sub) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Not the run owner' } }, 403);
  }

  await stub.fetch(new Request('http://do/cancel', { method: 'POST' }));

  const spaceId = statusData.data?.space_id ?? '';
  if (spaceId) {
    const gate = concurrencyStub(c.env, spaceId);
    await gate.fetch(new Request('http://do/release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId }),
    }));
  }

  return c.json({ data: { cancelled: true } });
});

app.get('/agents/runs', async (c) => {
  let jwt: JWTPayload;
  try {
    jwt = await extractJWT(c.req.raw, c.env.NAELAO_JWT_SECRET);
  } catch {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing token' } }, 401);
  }
  const spaceId = c.req.query('spaceId') ?? jwt.spaceId;
  const limit = c.req.query('limit') ?? '20';
  const cursor = c.req.query('cursor') ?? '';

  const resp = await c.env.NAELAO_SPACES.fetch(new Request(
    `http://spaces/internal/agents/runs?spaceId=${spaceId}&limit=${limit}&cursor=${encodeURIComponent(cursor)}`,
    { headers: { Authorization: c.req.header('Authorization') ?? '' } }
  ));
  return resp;
});

app.delete('/agents/run/:runId', async (c) => {
  let jwt: JWTPayload;
  try {
    jwt = await extractJWT(c.req.raw, c.env.NAELAO_JWT_SECRET);
  } catch {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing token' } }, 401);
  }
  const runId = c.req.param('runId');
  const stub = agentStub(c.env, runId);

  const statusResp = await stub.fetch(new Request('http://do/status'));
  const statusData = await statusResp.json<{ data: { userId?: string } }>();
  if (statusData.data?.userId && statusData.data.userId !== jwt.sub) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Not the run owner' } }, 403);
  }

  return stub.fetch(new Request('http://do/', { method: 'DELETE' }));
});

export default { fetch: app.fetch };
