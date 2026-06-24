interface Env {
  NAELAO_SPACE_DO: DurableObjectNamespace;
  NAELAO_CONCURRENCY_DO: DurableObjectNamespace;
  NAELAO_CONFIG_KV: KVNamespace;
  NAELAO_CIRCUIT_KV: KVNamespace;
  NAELAO_ANALYTICS: AnalyticsEngineDataset;
  NAELAO_DLQ: Queue;
  NAELAO_REGISTRY: Fetcher;
}

interface DLQMessage {
  body: unknown;
  retryCount?: number;
  timestamp?: number;
}

async function sweepHeartbeats(env: Env): Promise<void> {
  const cursor = (await env.NAELAO_CONFIG_KV.get('sweeper:heartbeat-cursor')) ?? undefined;
  const listed = await env.NAELAO_CONFIG_KV.list({ prefix: 'space:', limit: 100, cursor });

  for (const key of listed.keys) {
    const spaceId = key.name.slice('space:'.length);
    try {
      const concDO = env.NAELAO_CONCURRENCY_DO.get(env.NAELAO_CONCURRENCY_DO.idFromName(spaceId));
      await concDO.fetch(new Request('http://do/sweep-stale', { method: 'POST' }));
    } catch {
      // continue
    }
  }

  if (listed.list_complete) {
    await env.NAELAO_CONFIG_KV.delete('sweeper:heartbeat-cursor');
  } else {
    await env.NAELAO_CONFIG_KV.put('sweeper:heartbeat-cursor', listed.cursor ?? '');
  }
}

async function sweepAbandonedAgentRuns(env: Env): Promise<void> {
  const cursor = (await env.NAELAO_CONFIG_KV.get('sweeper:concurrency-cursor')) ?? undefined;
  const listed = await env.NAELAO_CONFIG_KV.list({ prefix: 'space:', limit: 100, cursor });

  for (const key of listed.keys) {
    const spaceId = key.name.slice('space:'.length);
    try {
      const concDO = env.NAELAO_CONCURRENCY_DO.get(env.NAELAO_CONCURRENCY_DO.idFromName(spaceId));
      const slotsResp = await concDO.fetch(new Request('http://do/slots'));
      const slotsData = await slotsResp.json<{ slots: Array<{ run_id: string; last_heartbeat: string }> }>();
      const staleMs = Date.now() - 5 * 60_000;
      for (const slot of slotsData.slots ?? []) {
        if (new Date(slot.last_heartbeat).getTime() < staleMs) {
          await concDO.fetch(new Request('http://do/release', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ runId: slot.run_id }),
          }));
        }
      }
    } catch {
      // continue
    }
  }

  if (listed.list_complete) {
    await env.NAELAO_CONFIG_KV.delete('sweeper:concurrency-cursor');
  } else {
    await env.NAELAO_CONFIG_KV.put('sweeper:concurrency-cursor', listed.cursor ?? '');
  }
}

async function sweepStaleFineTuneJobs(_env: Env): Promise<void> {
  // Placeholder: fine-tune job sweeping requires listing jobs from SpaceDO
  // and calling Together AI API. Not implemented without a space-index mechanism.
}

async function sweepCanaryRollouts(env: Env): Promise<void> {
  await env.NAELAO_REGISTRY.fetch(new Request('https://placeholder/v1/registry/canary/process', {
    method: 'POST',
  }));
}

async function sweepExpiredFileLocks(env: Env): Promise<void> {
  const listed = await env.NAELAO_CONFIG_KV.list({ prefix: 'filelock:' });
  const now = Date.now();
  await Promise.all(listed.keys.map(async (key) => {
    const val = await env.NAELAO_CONFIG_KV.getWithMetadata<{ expiresAt: number }>(key.name, 'json');
    if (val.metadata && val.metadata.expiresAt < now) {
      await env.NAELAO_CONFIG_KV.delete(key.name);
    }
  }));
}

async function runSweepTasks(env: Env): Promise<void> {
  const results = await Promise.allSettled([
    sweepHeartbeats(env),
    sweepAbandonedAgentRuns(env),
    sweepStaleFineTuneJobs(env),
    sweepCanaryRollouts(env),
    sweepExpiredFileLocks(env),
  ]);

  const errors = results.filter(r => r.status === 'rejected').length;
  env.NAELAO_ANALYTICS.writeDataPoint({
    blobs: ['sweep_complete'],
    doubles: [errors],
  });
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runSweepTasks(env));
  },

  async queue(batch: MessageBatch<DLQMessage>, env: Env): Promise<void> {
    const maxRetries = 5;
    const maxAgeMs = 3 * 86400_000;
    const now = Date.now();

    for (const msg of batch.messages) {
      const retryCount = (msg.body.retryCount ?? 0);
      const timestamp = (msg.body.timestamp ?? now);
      if (retryCount >= maxRetries || now - timestamp > maxAgeMs) {
        msg.ack();
        continue;
      }
      try {
        await env.NAELAO_DLQ.send({
          ...msg.body as Record<string, unknown>,
          retryCount: retryCount + 1,
          timestamp,
        });
        msg.ack();
      } catch {
        msg.retry();
      }
    }
  },
};
