# Prompt 25b — naelao-eval Worker (QA / Benchmark Pipeline)

## File to Generate
`workers/naelao-eval/src/index.ts`

## Context
Naelao runs entirely on Cloudflare Workers + Durable Objects. The `naelao-eval` worker
provides an internal QA and benchmarking pipeline for evaluating agent quality:
- Run benchmark test suites against agent responses
- Score outputs with an LLM judge (Together AI)
- Store results in R2 and report to Analytics Engine
- Triggered by cron schedule or internal POST (never user-facing)

This worker is INTERNAL ONLY — it is not exposed via the public router. Access is
restricted to requests carrying a valid `X-Admin-Secret` header.

## Environment Bindings
```
TOGETHER_AI_SERVICE — Service binding to naelao-together-ai worker
ANALYTICS_SERVICE   — Service binding to naelao-analytics worker
R2_EVAL_RESULTS     — R2Bucket  (bucket name: naelao-eval-results)
KV_EVAL_LOCK        — KVNamespace (prevents concurrent eval runs)
ADMIN_SECRET        — string (shared secret for internal auth)
EVAL_SPACE_ID       — string (dedicated eval space, never a real user space)
MAX_EVAL_CONCURRENCY — string (default "3")
```

## Eval Suite Format
Eval suites are stored in R2 at `suites/<suite-name>.json`:
```typescript
interface EvalSuite {
  name: string;
  description: string;
  cases: EvalCase[];
}
interface EvalCase {
  id: string;
  prompt: string;
  expectedBehaviors: string[];  // natural language descriptions of what a good response does
  scoringCriteria: string;      // instruction for LLM judge
  maxScore: number;             // typically 10
}
```

## Routes

### POST /eval/run
Run a named eval suite.

**Auth:** Require `X-Admin-Secret` header matching `ADMIN_SECRET`.

**Body:** `{ suiteName: string; model?: string; runLabel?: string; }`

**Logic:**
1. Check KV lock: `KV_EVAL_LOCK.get('lock:' + suiteName)` — return 409 if exists
2. Set lock with 30-minute TTL: `KV_EVAL_LOCK.put('lock:' + suiteName, runId, { expirationTtl: 1800 })`
3. Load suite from R2: `R2_EVAL_RESULTS.get('suites/' + suiteName + '.json')`
4. For each case (up to `MAX_EVAL_CONCURRENCY` in parallel):
   a. Call `TOGETHER_AI_SERVICE.fetch('/v1/chat/completions', ...)` with the case prompt
   b. Get LLM response
   c. Score it: call Together AI again with the judge prompt (see below)
   d. Parse score from judge response
5. Aggregate results: mean score, pass rate (score >= 7 = pass), per-case breakdown
6. Write results to R2: `eval-results/<suiteName>/<runId>.json`
7. Write summary to R2: `eval-results/<suiteName>/latest.json`
8. Report to analytics: POST to `ANALYTICS_SERVICE` with event type `eval_completed`
9. Release KV lock
10. Return `{ runId, suiteName, meanScore, passRate, cases: [...] }`

### GET /eval/results/:suiteName/latest
Return latest eval results for a suite.

**Auth:** `X-Admin-Secret` required.

**Logic:** Read `eval-results/<suiteName>/latest.json` from R2, return parsed JSON.

### GET /eval/results/:suiteName/:runId
Return specific eval run results.

**Auth:** `X-Admin-Secret` required.

### POST /eval/suites/:suiteName
Create or update an eval suite.

**Auth:** `X-Admin-Secret` required.

**Body:** `EvalSuite` JSON

**Logic:** Write to R2 at `suites/<suiteName>.json`, return `{ created: true }`.

### GET /eval/suites
List available eval suites.

**Auth:** `X-Admin-Secret` required.

**Logic:** R2 list with prefix `suites/`, return array of suite names.

## LLM Judge Prompt Pattern
```typescript
function buildJudgePrompt(evalCase: EvalCase, agentResponse: string): string {
  return `You are an objective evaluator for an AI assistant.

TASK GIVEN TO ASSISTANT:
${evalCase.prompt}

ASSISTANT RESPONSE:
${agentResponse}

SCORING CRITERIA:
${evalCase.scoringCriteria}

EXPECTED BEHAVIORS (check each):
${evalCase.expectedBehaviors.map((b, i) => `${i+1}. ${b}`).join('\n')}

Score the response from 0 to ${evalCase.maxScore}.
Respond with JSON only: {"score": <number>, "reasoning": "<brief explanation>", "behaviors_met": [<indices of met behaviors>]}`;
}
```

Parse judge response: extract JSON from response text (it may be wrapped in markdown
code fences — strip them). If parse fails, score = 0.

## Cron Handler
The worker should also handle `scheduled` events (cron trigger `0 6 * * *` = 6am UTC daily):
```typescript
async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
  // Run all suites sequentially to avoid lock conflicts
  const suiteList = await listSuites(env);
  for (const suiteName of suiteList) {
    const resp = await runSuite(env, suiteName, 'daily-cron');
    // Log result but don't throw — one failing suite shouldn't stop others
  }
}
```

## Together AI Call Pattern
```typescript
async function callModel(env: Env, messages: {role:string; content:string}[], model?: string) {
  const resp = await env.TOGETHER_AI_SERVICE.fetch('https://placeholder/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model ?? 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      messages,
      max_tokens: 1024,
      temperature: 0.0,  // deterministic for eval scoring
    }),
  });
  if (!resp.ok) throw new Error('model call failed: ' + resp.status);
  const data = await resp.json() as { choices: [{message:{content:string}}] };
  return data.choices[0].message.content;
}
```

## Error Handling
- 401 if `X-Admin-Secret` missing or wrong
- 409 if eval already running (lock held)
- 404 if suite not found in R2
- 500 with `{ error: string }` for unexpected errors
- Always release KV lock in a `finally` block

## Output
Generate the complete `workers/naelao-eval/src/index.ts` using Hono. Export:
- Default fetch handler
- Named `scheduled` export for cron
- `Env` interface

Keep focused — total file under 300 lines. The Together AI service binding URL
placeholder (`https://placeholder/`) is fine; the service binding routes internally.
