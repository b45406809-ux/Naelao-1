import { Hono } from 'hono';
import { verifyJWT } from '../../naelao-auth/src/jwt';

interface Env {
  TOGETHER_AI_API_KEY: string;
  NAELAO_WALLET_DO: DurableObjectNamespace;
  NAELAO_SPACE_DO: DurableObjectNamespace;
  NAELAO_ANALYTICS: AnalyticsEngineDataset;
  NAELAO_JWT_SECRET: string;
  NAELAO_CONFIG_KV: KVNamespace;
  NAELAO_CIRCUIT_KV: KVNamespace;
}

const MODEL_CREDIT_RATES: Record<string, number> = {
  'meta-llama/Llama-3.3-70B-Instruct-Turbo': 10,
  'Qwen/Qwen2.5-72B-Instruct-Turbo': 15,
  'deepseek-ai/DeepSeek-R1': 25,
};

function creditRateForModel(model: string): number {
  return MODEL_CREDIT_RATES[model] ?? 20;
}

function walletStub(env: Env, userId: string) {
  return env.NAELAO_WALLET_DO.get(env.NAELAO_WALLET_DO.idFromName('wallet:' + userId));
}

function spaceStub(env: Env, spaceId: string) {
  return env.NAELAO_SPACE_DO.get(env.NAELAO_SPACE_DO.idFromName('space:' + spaceId));
}

const app = new Hono<{ Bindings: Env }>();

app.use('*', async (c, next) => {
  const token = (c.req.header('Authorization') ?? '').replace('Bearer ', '');
  if (!token) return c.json({ error: { code: 'UNAUTHORIZED', message: 'Missing token' } }, 401);
  try {
    const jwt = await verifyJWT(token, c.env.NAELAO_JWT_SECRET);
    c.set('jwt' as never, jwt);
  } catch {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid token' } }, 401);
  }
  await next();
});

app.post('/v1/ai/chat', async (c) => {
  const jwt = c.get('jwt' as never) as { sub: string; spaceId: string };
  const body = await c.req.json<{
    model: string;
    messages: unknown[];
    stream?: boolean;
    tools?: unknown[];
    spaceId?: string;
    runId?: string;
    max_tokens?: number;
  }>();

  const model = body.model ?? 'meta-llama/Llama-3.3-70B-Instruct-Turbo';
  const spaceId = body.spaceId ?? jwt.spaceId;
  const rate = creditRateForModel(model);
  const maxCredits = rate * 10;

  const wallet = walletStub(c.env, jwt.sub);
  const reserveResp = await wallet.fetch(new Request('http://wallet/reserve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: maxCredits }),
  }));

  let reservationId: string | null = null;
  if (reserveResp.ok) {
    const reserveData = await reserveResp.json<{ data?: { reservationId: string } }>();
    reservationId = reserveData.data?.reservationId ?? null;
  }

  const startTime = Date.now();

  const togetherResp = await fetch('https://api.together.xyz/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + c.env.TOGETHER_AI_API_KEY,
    },
    body: JSON.stringify({
      model,
      messages: body.messages,
      tools: body.tools,
      stream: body.stream ?? false,
      max_tokens: body.max_tokens ?? 4096,
    }),
  });

  const settleCredits = async (actualTokens: number) => {
    const actualCredits = Math.ceil(actualTokens * rate / 1000);
    if (reservationId) {
      await wallet.fetch(new Request('http://wallet/settle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reservationId, actual: actualCredits }),
      }));
    }
    c.env.NAELAO_ANALYTICS.writeDataPoint({
      blobs: ['token_usage', spaceId, 'ai_chat', model],
      doubles: [actualCredits, Date.now() - startTime, actualTokens],
    });
  };

  if (body.stream) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    let totalTokens = 0;

    c.executionCtx.waitUntil((async () => {
      const reader = togetherResp.body!.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          await writer.write(new TextEncoder().encode(chunk));
          const lines = chunk.split('\n');
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data) as { usage?: { total_tokens?: number } };
              if (parsed.usage?.total_tokens) totalTokens = parsed.usage.total_tokens;
            } catch { /* skip */ }
          }
        }
      } finally {
        await writer.close();
        await settleCredits(totalTokens);
      }
    })());

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    });
  }

  const data = await togetherResp.json() as { usage?: { total_tokens?: number } };
  const totalTokens = (data as { usage?: { total_tokens?: number } }).usage?.total_tokens ?? 0;
  c.executionCtx.waitUntil(settleCredits(totalTokens));

  return Response.json(data);
});

app.post('/v1/ai/finetune/start', async (c) => {
  const jwt = c.get('jwt' as never) as { sub: string; spaceId: string };
  const { model, dataset, epochs = 3, spaceId } = await c.req.json<{
    model: string; dataset: string[]; epochs?: number; spaceId?: string;
  }>();

  const resp = await fetch('https://api.together.xyz/v1/fine-tunes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + c.env.TOGETHER_AI_API_KEY,
    },
    body: JSON.stringify({ model, training_data: dataset, num_epochs: epochs }),
  });

  if (!resp.ok) {
    return c.json({ error: { code: 'FINETUNE_FAILED', message: 'Failed to start fine-tune job' } }, 502);
  }

  const data = await resp.json<{ id: string }>();
  const jobId = data.id;
  const sid = spaceId ?? jwt.spaceId;

  const stub = spaceStub(c.env, sid);
  await stub.fetch(new Request('http://space/finetune/jobs/record', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId, model, status: 'queued', userId: jwt.sub }),
  }));

  return c.json({ data: { jobId, status: 'queued' } });
});

app.get('/v1/ai/finetune/:jobId/status', async (c) => {
  const jwt = c.get('jwt' as never) as { sub: string; spaceId: string };
  const jobId = c.req.param('jobId');

  const resp = await fetch('https://api.together.xyz/v1/fine-tunes/' + jobId, {
    headers: { 'Authorization': 'Bearer ' + c.env.TOGETHER_AI_API_KEY },
  });

  if (!resp.ok) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Job not found' } }, 404);
  }

  const data = await resp.json<{ status: string; output_name?: string }>();

  const stub = spaceStub(c.env, jwt.spaceId);
  await stub.fetch(new Request('http://space/finetune/jobs/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId, status: data.status, resultModel: data.output_name }),
  }));

  return c.json({ data: { status: data.status, resultModel: data.output_name } });
});

export default { fetch: app.fetch };
