import { Hono } from 'hono';
import { verifyJWT } from '../../naelao-auth/src/jwt';

export { ThreadsDO } from './ThreadsDO';

interface Env {
  NAELAO_THREADS_DO: DurableObjectNamespace;
  NAELAO_SPACE_DO: DurableObjectNamespace;
  NAELAO_JWT_SECRET: string;
}

function getThreadsDO(threadId: string, env: Env) {
  return env.NAELAO_THREADS_DO.get(env.NAELAO_THREADS_DO.idFromName('thread:' + threadId));
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

app.post('/v1/threads', async (c) => {
  const jwt = c.get('jwt' as never) as { spaceId: string };
  const body = await c.req.json<{ projectId?: string; title?: string }>().catch(() => ({}));
  const threadId = crypto.randomUUID();
  const do_ = getThreadsDO(threadId, c.env);
  return do_.fetch(new Request('http://do/threads/create', {
    method: 'POST',
    body: JSON.stringify({ spaceId: jwt.spaceId, projectId: body.projectId, title: body.title }),
  }));
});

app.get('/v1/threads/:threadId', async (c) => {
  const threadId = c.req.param('threadId');
  const do_ = getThreadsDO(threadId, c.env);
  return do_.fetch(new Request('http://do/threads/' + threadId));
});

app.delete('/v1/threads/:threadId', async (c) => {
  const threadId = c.req.param('threadId');
  const do_ = getThreadsDO(threadId, c.env);
  return do_.fetch(new Request('http://do/threads/' + threadId, { method: 'DELETE' }));
});

app.post('/v1/threads/:threadId/messages', async (c) => {
  const threadId = c.req.param('threadId');
  const { role, content, toolCallId } = await c.req.json<{ role: string; content: string; toolCallId?: string }>();
  const do_ = getThreadsDO(threadId, c.env);
  return do_.fetch(new Request('http://do/messages/add', {
    method: 'POST',
    body: JSON.stringify({ threadId, role, content, toolCallId }),
  }));
});

app.get('/v1/threads/:threadId/messages', async (c) => {
  const threadId = c.req.param('threadId');
  const cursor = c.req.query('cursor') ?? '';
  const limit = c.req.query('limit') ?? '100';
  const do_ = getThreadsDO(threadId, c.env);
  const qs = new URLSearchParams({ ...(cursor ? { cursor } : {}), limit });
  return do_.fetch(new Request('http://do/messages/' + threadId + '?' + qs.toString()));
});

app.get('/v1/threads/:threadId/stream', async (c) => {
  const jwt = c.get('jwt' as never) as { sub: string };
  const threadId = c.req.param('threadId');
  const agentId = c.req.query('agentId') ?? jwt.sub;

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const keepAlive = setInterval(() => {
    writer.write(encoder.encode(': keepalive\n\n')).catch(() => clearInterval(keepAlive));
  }, 15000);

  c.executionCtx.waitUntil(
    (async () => {
      try {
        await writer.write(encoder.encode(`data: {"type":"connected","agentId":"${agentId}"}\n\n`));
      } catch { /* client disconnected */ } finally {
        clearInterval(keepAlive);
        writer.close().catch(() => {});
      }
    })()
  );

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
});

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
};
