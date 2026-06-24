interface AnalyticsEvent {
  event_type: string;
  space_id?: string;
  agent_id?: string;
  model_id?: string;
  run_id?: string;
  billing_provider?: string;
  credits_used?: number;
  duration_ms?: number;
  token_count?: number;
  amount_cents?: number;
  trace_id?: string;
}

interface Env {
  NAELAO_ANALYTICS: AnalyticsEngineDataset;
  NAELAO_CONFIG_KV: KVNamespace;
  NAELAO_CIRCUIT_KV: KVNamespace;
  NAELAO_DLQ: Queue;
}

export default {
  async queue(batch: MessageBatch<AnalyticsEvent>, env: Env): Promise<void> {
    await Promise.allSettled(batch.messages.map(async (msg) => {
      const e = msg.body;
      try {
        const blobs: [string?, string?, string?, string?, string?, string?] = [
          e.event_type, e.space_id, e.agent_id, e.model_id, e.run_id, e.billing_provider,
        ];
        const doubles: [number?, number?, number?, number?, number?, number?] = [
          e.credits_used, e.duration_ms, e.token_count, e.amount_cents, undefined, undefined,
        ];
        await env.NAELAO_ANALYTICS.writeDataPoint({
          blobs,
          doubles,
          indexes: e.trace_id ? [e.trace_id] : undefined,
        });
        msg.ack();
      } catch (err) {
        try {
          await env.NAELAO_DLQ.send(e);
        } catch {
          // DLQ send failed too; let CF retry the message
        }
        msg.retry();
      }

      if (e.event_type?.startsWith('security_')) {
        try {
          await env.NAELAO_CONFIG_KV.put(
            'sec-event:' + Date.now() + ':' + e.event_type,
            JSON.stringify(e),
            { expirationTtl: 86400 * 30 }
          );
        } catch {
          // best-effort backup
        }
      }
    }));
  },
};
