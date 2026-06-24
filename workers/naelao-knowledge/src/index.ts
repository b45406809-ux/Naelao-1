import { Hono } from 'hono';
import { verifyJWT } from '../../naelao-auth/src/jwt';
import { chunkText, extractText } from './chunker';
import { embedText, upsertChunks, deleteDocChunks } from './embedder';

interface Env {
  NAELAO_VECTORIZE: VectorizeIndex;
  NAELAO_SPACE_DO: DurableObjectNamespace;
  NAELAO_ANALYTICS_QUEUE: Queue;
  NAELAO_KNOWLEDGE_QUEUE: Queue;
  AI: Ai;
  NAELAO_R2: R2Bucket;
  NAELAO_JWT_SECRET: string;
  NAELAO_CONFIG_KV: KVNamespace;
  NAELAO_CIRCUIT_KV: KVNamespace;
}

interface KnowledgeIndexMessage {
  type: 'knowledge_index';
  docId: string;
  spaceId: string;
  content: string;
  title: string;
  mimeType?: string;
}

function getSpaceDO(spaceId: string, env: Env) {
  return env.NAELAO_SPACE_DO.get(env.NAELAO_SPACE_DO.idFromName('space:' + spaceId));
}

const app = new Hono<{ Bindings: Env }>();

app.use('/v1/*', async (c, next) => {
  const auth = c.req.header('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Token required' } }, 401);
  }
  try {
    await verifyJWT(auth.slice(7), c.env.NAELAO_JWT_SECRET);
  } catch {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid token' } }, 401);
  }
  await next();
});

app.post('/v1/knowledge/:spaceId/ingest', async (c) => {
  const spaceId = c.req.param('spaceId');
  const { title, content, mimeType, projectId } = await c.req.json<{
    title: string; content: string; mimeType?: string; projectId?: string;
  }>();

  const docId = crypto.randomUUID();
  const spaceDO = getSpaceDO(spaceId, c.env);

  await spaceDO.fetch(new Request('http://space/knowledge/docs/create', {
    method: 'POST',
    body: JSON.stringify({ id: docId, title, projectId, mimeType }),
  }));

  await c.env.NAELAO_KNOWLEDGE_QUEUE.send({
    type: 'knowledge_index',
    docId,
    spaceId,
    content,
    title,
    mimeType,
  });

  return c.json({ data: { docId, status: 'queued' } });
});

app.get('/v1/knowledge/:spaceId/documents', async (c) => {
  const spaceId = c.req.param('spaceId');
  const spaceDO = getSpaceDO(spaceId, c.env);
  const resp = await spaceDO.fetch(new Request('http://space/knowledge/docs'));
  return resp;
});

app.get('/v1/knowledge/:spaceId/documents/:docId/status', async (c) => {
  const spaceId = c.req.param('spaceId');
  const docId = c.req.param('docId');
  const spaceDO = getSpaceDO(spaceId, c.env);
  const resp = await spaceDO.fetch(new Request('http://space/knowledge/docs/' + docId + '/status'));
  return resp;
});

app.delete('/v1/knowledge/:spaceId/documents/:docId', async (c) => {
  const spaceId = c.req.param('spaceId');
  const docId = c.req.param('docId');
  const spaceDO = getSpaceDO(spaceId, c.env);

  const statusResp = await spaceDO.fetch(new Request('http://space/knowledge/docs/' + docId + '/status'));
  const statusData = await statusResp.json<{ data: { chunk_count?: number } | null }>();
  const chunkCount = statusData.data?.chunk_count ?? 0;

  await deleteDocChunks(c.env.NAELAO_VECTORIZE, docId, chunkCount);

  await spaceDO.fetch(new Request('http://space/knowledge/docs/' + docId, { method: 'DELETE' }));

  return c.json({ data: { ok: true } });
});

app.post('/v1/knowledge/:spaceId/search', async (c) => {
  const spaceId = c.req.param('spaceId');
  const { query, topK, projectId } = await c.req.json<{ query: string; topK?: number; projectId?: string }>();

  const embedding = await embedText(query, c.env.AI);
  const results = await c.env.NAELAO_VECTORIZE.query(embedding, {
    topK: topK ?? 10,
    filter: { spaceId: { $eq: spaceId } },
    returnMetadata: true,
  });

  const filtered = results.matches.filter(m => m.metadata?.['spaceId'] === spaceId);

  return c.json({
    data: {
      results: filtered.map(m => ({
        docId: m.metadata?.['docId'],
        chunkIndex: m.metadata?.['chunkIndex'],
        score: m.score,
        text: m.metadata?.['text'],
      })),
    }
  });
});

async function processKnowledgeIndex(msg: KnowledgeIndexMessage, env: Env): Promise<void> {
  const spaceDO = getSpaceDO(msg.spaceId, env);

  await spaceDO.fetch(new Request('http://space/knowledge/docs/' + msg.docId + '/status', {
    method: 'POST',
    body: JSON.stringify({ status: 'indexing' }),
  }));

  try {
    const text = extractText(msg.content, msg.mimeType ?? 'text/plain');
    const chunks = chunkText(text);
    await upsertChunks(env.NAELAO_VECTORIZE, msg.docId, msg.spaceId, chunks, env.AI);

    await spaceDO.fetch(new Request('http://space/knowledge/docs/' + msg.docId + '/status', {
      method: 'POST',
      body: JSON.stringify({ status: 'ready', chunkCount: chunks.length }),
    }));
  } catch (err) {
    await spaceDO.fetch(new Request('http://space/knowledge/docs/' + msg.docId + '/status', {
      method: 'POST',
      body: JSON.stringify({ status: 'failed', errorMessage: String(err) }),
    }));
    throw err;
  }
}

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),

  async queue(batch: MessageBatch<KnowledgeIndexMessage>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        if (msg.body.type === 'knowledge_index') {
          await processKnowledgeIndex(msg.body, env);
        }
        msg.ack();
      } catch (err) {
        console.error('knowledge index failed:', err);
        msg.retry();
      }
    }
  },
};
