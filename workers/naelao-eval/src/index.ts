import { Hono } from 'hono';

interface EvalCase {
  id: string;
  prompt: string;
  expectedBehaviors: string[];
  scoringCriteria: string;
  maxScore: number;
}

interface EvalSuite {
  name: string;
  description: string;
  cases: EvalCase[];
}

interface CaseResult {
  id: string;
  score: number;
  maxScore: number;
  passed: boolean;
  reasoning: string;
  behaviorsMet: number[];
}

interface Env {
  TOGETHER_AI_SERVICE: Fetcher;
  ANALYTICS_SERVICE: Fetcher;
  R2_EVAL_RESULTS: R2Bucket;
  KV_EVAL_LOCK: KVNamespace;
  NAELAO_CONFIG_KV: KVNamespace;
  NAELAO_CIRCUIT_KV: KVNamespace;
  ADMIN_SECRET: string;
  EVAL_SPACE_ID: string;
  MAX_EVAL_CONCURRENCY: string;
}

function requireAdmin(c: { req: { header: (h: string) => string | undefined } }, env: Env): boolean {
  return c.req.header('X-Admin-Secret') === env.ADMIN_SECRET;
}

function buildJudgePrompt(evalCase: EvalCase, agentResponse: string): string {
  return `You are an objective evaluator for an AI assistant.

TASK GIVEN TO ASSISTANT:
${evalCase.prompt}

ASSISTANT RESPONSE:
${agentResponse}

SCORING CRITERIA:
${evalCase.scoringCriteria}

EXPECTED BEHAVIORS (check each):
${evalCase.expectedBehaviors.map((b, i) => `${i + 1}. ${b}`).join('\n')}

Score the response from 0 to ${evalCase.maxScore}.
Respond with JSON only: {"score": <number>, "reasoning": "<brief explanation>", "behaviors_met": [<indices of met behaviors>]}`;
}

async function callModel(env: Env, messages: { role: string; content: string }[], model?: string): Promise<string> {
  const resp = await env.TOGETHER_AI_SERVICE.fetch(new Request('https://placeholder/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model ?? 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      messages,
      max_tokens: 1024,
      temperature: 0.0,
    }),
  }));
  if (!resp.ok) throw new Error('model call failed: ' + resp.status);
  const data = await resp.json() as { choices: [{ message: { content: string } }] };
  return data.choices[0]!.message.content;
}

async function scoreCase(evalCase: EvalCase, agentResponse: string, env: Env, model?: string): Promise<CaseResult> {
  const judgePrompt = buildJudgePrompt(evalCase, agentResponse);
  const judgeResponse = await callModel(env, [{ role: 'user', content: judgePrompt }], model);

  let score = 0;
  let reasoning = '';
  let behaviorsMet: number[] = [];

  try {
    const cleaned = judgeResponse.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned) as { score: number; reasoning: string; behaviors_met: number[] };
    score = parsed.score;
    reasoning = parsed.reasoning;
    behaviorsMet = parsed.behaviors_met;
  } catch {
    score = 0;
    reasoning = 'Failed to parse judge response';
  }

  return {
    id: evalCase.id,
    score,
    maxScore: evalCase.maxScore,
    passed: score >= 7,
    reasoning,
    behaviorsMet,
  };
}

async function listSuites(env: Env): Promise<string[]> {
  const listed = await env.R2_EVAL_RESULTS.list({ prefix: 'suites/' });
  return listed.objects
    .map(o => o.key.replace('suites/', '').replace('.json', ''))
    .filter(Boolean);
}

async function runSuite(env: Env, suiteName: string, runLabel: string, model?: string) {
  const runId = crypto.randomUUID();
  const lockKey = 'lock:' + suiteName;

  const existing = await env.KV_EVAL_LOCK.get(lockKey);
  if (existing) throw Object.assign(new Error('already_running'), { status: 409 });

  await env.KV_EVAL_LOCK.put(lockKey, runId, { expirationTtl: 1800 });

  try {
    const suiteObj = await env.R2_EVAL_RESULTS.get('suites/' + suiteName + '.json');
    if (!suiteObj) throw Object.assign(new Error('suite_not_found'), { status: 404 });
    const suite = await suiteObj.json<EvalSuite>();

    const concurrency = parseInt(env.MAX_EVAL_CONCURRENCY ?? '3');
    const results: CaseResult[] = [];

    for (let i = 0; i < suite.cases.length; i += concurrency) {
      const batch = suite.cases.slice(i, i + concurrency);
      const batchResults = await Promise.all(batch.map(async (evalCase) => {
        const response = await callModel(env, [{ role: 'user', content: evalCase.prompt }], model);
        return scoreCase(evalCase, response, env, model);
      }));
      results.push(...batchResults);
    }

    const meanScore = results.reduce((s, r) => s + r.score, 0) / results.length;
    const passRate = results.filter(r => r.passed).length / results.length;

    const summary = { runId, suiteName, runLabel, model, meanScore, passRate, cases: results, timestamp: new Date().toISOString() };

    await env.R2_EVAL_RESULTS.put('eval-results/' + suiteName + '/' + runId + '.json', JSON.stringify(summary));
    await env.R2_EVAL_RESULTS.put('eval-results/' + suiteName + '/latest.json', JSON.stringify(summary));

    await env.ANALYTICS_SERVICE.fetch(new Request('https://placeholder/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_type: 'eval_completed', space_id: 'eval', run_id: runId }),
    }));

    return summary;
  } finally {
    await env.KV_EVAL_LOCK.delete(lockKey);
  }
}

const app = new Hono<{ Bindings: Env }>();

app.use('*', async (c, next) => {
  if (!requireAdmin(c, c.env)) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid admin secret' } }, 401);
  }
  await next();
});

app.post('/eval/run', async (c) => {
  const { suiteName, model, runLabel = 'manual' } = await c.req.json<{
    suiteName: string; model?: string; runLabel?: string;
  }>();
  try {
    const result = await runSuite(c.env, suiteName, runLabel, model);
    return c.json({ data: result });
  } catch (e) {
    const err = e as { status?: number; message: string };
    return c.json({ error: { code: 'EVAL_ERROR', message: err.message } }, (err.status ?? 500) as 409 | 404 | 500);
  }
});

app.get('/eval/results/:suiteName/latest', async (c) => {
  const suiteName = c.req.param('suiteName');
  const obj = await c.env.R2_EVAL_RESULTS.get('eval-results/' + suiteName + '/latest.json');
  if (!obj) return c.json({ error: { code: 'NOT_FOUND', message: 'No results found' } }, 404);
  return c.json(await obj.json());
});

app.get('/eval/results/:suiteName/:runId', async (c) => {
  const { suiteName, runId } = c.req.param();
  const obj = await c.env.R2_EVAL_RESULTS.get('eval-results/' + suiteName + '/' + runId + '.json');
  if (!obj) return c.json({ error: { code: 'NOT_FOUND', message: 'Run not found' } }, 404);
  return c.json(await obj.json());
});

app.post('/eval/suites/:suiteName', async (c) => {
  const suiteName = c.req.param('suiteName');
  const body = await c.req.json();
  await c.env.R2_EVAL_RESULTS.put('suites/' + suiteName + '.json', JSON.stringify(body));
  return c.json({ data: { created: true } });
});

app.get('/eval/suites', async (c) => {
  const suiteNames = await listSuites(c.env);
  return c.json({ data: { suites: suiteNames } });
});

async function scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
  const suiteNames = await listSuites(env);
  for (const suiteName of suiteNames) {
    try {
      await runSuite(env, suiteName, 'daily-cron');
    } catch {
      // continue to next suite
    }
  }
}

export default { fetch: app.fetch, scheduled };
