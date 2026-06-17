# Prompt: workers/naelao-sweeper/src/index.ts

---
## PASTE THIS ENTIRE BLOCK INTO YOUR FREE AI
---

Naelao = multi-tenant AI agent builder on Cloudflare Workers + Durable Objects. NO Node.js, NO PostgreSQL. Data in SpaceDO SQLite. Service Bindings for Worker comms. Hono for routing. JWT auth. Errors: { error: { code: 'SNAKE_CASE', message: 'text' } }. All routes /v1/. compatibility_date: 2025-01-01.

Generate ONE file: workers/naelao-sweeper/src/index.ts

Scheduled worker that runs cleanup tasks every minute.

Env:
  NAELAO_SPACE_DO: DurableObjectNamespace
  NAELAO_CONCURRENCY_DO: DurableObjectNamespace
  NAELAO_CONFIG_KV: KVNamespace
  NAELAO_ANALYTICS: AnalyticsEngineDataset
  NAELAO_DLQ: Queue
  NAELAO_REGISTRY: Service  (Service Binding to naelao-registry)

Export default with scheduled handler:
  export default {
    async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
      ctx.waitUntil(runSweepTasks(env));
    }
  }

CRITICAL FIX (G-E10): Never load all users at once. Paginate using cursor stored in KV:
  async function sweepHeartbeats(env: Env): Promise<void>
    const cursor = await env.NAELAO_CONFIG_KV.get('sweeper:heartbeat-cursor');
    Process 100 spaces per run, advance cursor
    When cursor wraps: reset to beginning
    Use KV.list({ prefix: 'space:', limit: 100, cursor }) pattern
    CRITICAL (G-I12 fix): KV 'space:*' keys are ONLY available if naelao-spaces writes them
    at createSpace time (POST /internal/space-index/register). If these keys don't exist,
    sweepHeartbeats finds zero spaces. Confirm naelao-spaces wires this up.

Tasks to run (all via Promise.allSettled to prevent one failure blocking others):
  sweepAbandonedAgentRuns(env)
    - Get ConcurrencyDOs for active spaces (paginated, 100 per run)
    - Call /slots on each to find stale runs
    - Force-release runs with no heartbeat > 5min
    
  sweepStaleFineTuneJobs(env)
    - Find running fine-tune jobs in SpaceDO (paginated)
    - Call Together AI API to check job status
    - Update status in SpaceDO via /billing/update or custom endpoint
    - CRITICAL (G-F12 fix): call SpaceDO Service Binding, NOT db.query()

  sweepCanaryRollouts(env)
    - Call naelao-registry Service Binding: POST /v1/registry/canary/process
    - This wires up the previously disconnected canary promotion (G-G11 fix)

  sweepDLQ — REMOVED. Do NOT implement a sweepDLQ() function.
    CRITICAL (G-I19 fix): CF Queues are push-only. There is no pull/consume API on a Queue
    producer binding. sweepDLQ() as a function is architecturally impossible.
    Instead: naelao-sweeper exports BOTH a scheduled handler AND a queue handler:
      export default { scheduled(...) { ... }, async queue(batch, env) { /* DLQ re-queue logic */ } }
    The queue handler receives DLQ messages that CF pushes to the consumer binding (see wrangler config).
    In the queue handler: check retryCount and age, discard if > 5 retries or > 3 days, else re-queue.

  sweepExpiredFileLocks(env)
    - Clean up expired file locks in KV (prefix: 'filelock:')

Log sweep results to NAELAO_ANALYTICS after each run.

