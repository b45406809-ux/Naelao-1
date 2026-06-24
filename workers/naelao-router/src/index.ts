import { Hono } from 'hono';
import { corsMiddleware } from './middleware/cors';
import { rateLimitMiddleware } from './middleware/rate-limit';
import { authMiddleware, requireRole } from './middleware/auth';

interface Env {
  NAELAO_AUTH: Fetcher;
  NAELAO_SPACES: Fetcher;
  NAELAO_AGENTS: Fetcher;
  NAELAO_THREADS: Fetcher;
  NAELAO_KNOWLEDGE: Fetcher;
  NAELAO_BILLING: Fetcher;
  NAELAO_MCP_HUB: Fetcher;
  NAELAO_REGISTRY: Fetcher;
  NAELAO_TOGETHER_AI: Fetcher;
  NAELAO_ADMIN: Fetcher;
  NAELAO_CREDENTIALS: Fetcher;
  NAELAO_TRIGGERS: Fetcher;
  NAELAO_CIRCUIT_KV: KVNamespace;
  NAELAO_CONFIG_KV: KVNamespace;
  NAELAO_JWT_SECRET: string;
  ENVIRONMENT: string;
}

interface JWTPayload {
  sub: string;
  spaceId: string;
  role: string;
}

type AppEnv = { Bindings: Env; Variables: { jwt?: JWTPayload; traceId?: string } };

function forward(service: Fetcher, c: { req: { url: string; method: string; raw: Request }; get: (k: string) => string | undefined }): Promise<Response> {
  const headers = new Headers(c.req.raw.headers);
  headers.set('X-Trace-ID', c.get('traceId') ?? '');
  return service.fetch(new Request(c.req.url, {
    method: c.req.method,
    headers,
    body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body,
  }));
}

const app = new Hono<AppEnv>();

app.use('*', corsMiddleware());

app.use('*', async (c, next) => {
  const traceId = c.req.header('X-Trace-ID') ?? crypto.randomUUID();
  c.set('traceId', traceId);
  c.header('X-Trace-ID', traceId);
  c.header('API-Version', '1');
  await next();
});

app.get('/health', (c) => c.json({ ok: true, timestamp: Date.now() }));

app.all('/v1/auth/*', (c) => forward(c.env.NAELAO_AUTH, c as never));

app.all('/v1/billing/webhook', (c) => forward(c.env.NAELAO_BILLING, c as never));

app.all('/v1/webhooks/*', (c) => forward(c.env.NAELAO_TRIGGERS, c as never));

const authenticated = new Hono<AppEnv>();
authenticated.use('*', async (c, next) => {
  const mw = authMiddleware(c.env);
  await mw(c as never, next);
});
authenticated.use('*', async (c, next) => {
  const mw = rateLimitMiddleware(c.env);
  await mw(c as never, next);
});

authenticated.all('/v1/spaces/*', (c) => forward(c.env.NAELAO_SPACES, c as never));
authenticated.all('/v1/agents/*', (c) => forward(c.env.NAELAO_AGENTS, c as never));
authenticated.all('/v1/threads/*', (c) => forward(c.env.NAELAO_THREADS, c as never));
authenticated.all('/v1/knowledge/*', (c) => forward(c.env.NAELAO_KNOWLEDGE, c as never));
authenticated.all('/v1/billing/*', (c) => forward(c.env.NAELAO_BILLING, c as never));
authenticated.all('/v1/registry/*', (c) => forward(c.env.NAELAO_REGISTRY, c as never));
authenticated.all('/v1/ai/*', (c) => forward(c.env.NAELAO_TOGETHER_AI, c as never));
authenticated.all('/v1/credentials/*', (c) => forward(c.env.NAELAO_CREDENTIALS, c as never));
authenticated.all('/v1/mcp/*', (c) => forward(c.env.NAELAO_MCP_HUB, c as never));

const admin = new Hono<AppEnv>();
admin.use('*', async (c, next) => {
  const mw = authMiddleware(c.env);
  await mw(c as never, next);
});
admin.use('*', requireRole('owner', 'admin'));
admin.use('*', async (c, next) => {
  const mw = rateLimitMiddleware(c.env);
  await mw(c as never, next);
});
admin.all('/*', (c) => forward(c.env.NAELAO_ADMIN, c as never));

app.route('/', authenticated);
app.route('/v1/admin', admin);

app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404));

export default { fetch: app.fetch };
