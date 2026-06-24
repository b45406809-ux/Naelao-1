import { Hono } from 'hono';
import { resolveToolRoute, cacheToolSchemas, invalidateToolCache } from './route-resolver';

interface Env {
  NAELAO_SPACE_DO: DurableObjectNamespace;
  NAELAO_CONFIG_KV: KVNamespace;
  NAELAO_CIRCUIT_KV: KVNamespace;
  NAELAO_JWT_SECRET: string;
  NAELAO_ANALYTICS: AnalyticsEngineDataset;
}

const PLATFORM_TOOLS = new Set([
  'naelao.read_file', 'naelao.write_file', 'naelao.append_to_file',
  'naelao.web_search', 'naelao.create_thread', 'naelao.add_message',
]);

function spaceDOStub(env: Env, spaceId: string) {
  return env.NAELAO_SPACE_DO.get(env.NAELAO_SPACE_DO.idFromName('space:' + spaceId));
}

async function fetchToolList(spaceId: string, agentId: string, env: Env): Promise<Record<string, string>> {
  const stub = spaceDOStub(env, spaceId);
  const resp = await stub.fetch(new Request('http://space/agents/tools?agentId=' + encodeURIComponent(agentId)));
  if (!resp.ok) return {};
  const data = await resp.json<{ tools?: Record<string, string> }>();
  const schemas = data.tools ?? {};
  await cacheToolSchemas(spaceId, agentId, schemas, env.NAELAO_CONFIG_KV);
  return schemas;
}

const app = new Hono<{ Bindings: Env }>();

app.get('/v1/tools/:spaceId', async (c) => {
  const spaceId = c.req.param('spaceId');
  const agentId = c.req.query('agentId');
  if (!agentId) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'agentId is required' } }, 400);
  }

  let tools = await resolveToolRoute(spaceId, '*', agentId, c.env.NAELAO_CONFIG_KV);
  const schemas = tools ? {} : await fetchToolList(spaceId, agentId, c.env);
  return c.json({ data: { tools: schemas } });
});

app.post('/v1/tools/:spaceId/execute', async (c) => {
  const spaceId = c.req.param('spaceId');
  const { toolName, args, agentId, runId, walEntryId } = await c.req.json<{
    toolName: string;
    args: Record<string, unknown>;
    agentId: string;
    runId: string;
    walEntryId: string;
  }>();

  if (PLATFORM_TOOLS.has(toolName)) {
    return c.json({ error: { code: 'PLATFORM_TOOL', message: 'Platform tools handled by agent executor' } }, 400);
  }

  let route = await resolveToolRoute(spaceId, toolName, agentId, c.env.NAELAO_CONFIG_KV);
  if (!route) {
    const schemas = await fetchToolList(spaceId, agentId, c.env);
    route = schemas[toolName] ?? null;
  }

  if (!route) {
    return c.json({ error: { code: 'TOOL_NOT_FOUND', message: 'Tool not found: ' + toolName } }, 404);
  }

  const idempotencyKey = runId + ':' + walEntryId;
  const resp = await fetch(route, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Naelao-Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({ toolName, args, agentId, runId }),
  });

  const result = await resp.json();
  return c.json({ result });
});

app.delete('/v1/tools/:spaceId/cache', async (c) => {
  const spaceId = c.req.param('spaceId');
  await invalidateToolCache(spaceId, c.env.NAELAO_CONFIG_KV);
  return c.json({ data: { ok: true } });
});

export default { fetch: app.fetch };
