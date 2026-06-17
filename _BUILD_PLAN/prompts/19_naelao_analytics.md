# Prompt: workers/naelao-analytics/src/index.ts

---
## PASTE THIS ENTIRE BLOCK INTO YOUR FREE AI
---

Naelao = multi-tenant AI agent builder on Cloudflare Workers + Durable Objects. NO Node.js, NO PostgreSQL. Data in SpaceDO SQLite. Service Bindings for Worker comms. Hono for routing. JWT auth. Errors: { error: { code: 'SNAKE_CASE', message: 'text' } }. All routes /v1/. compatibility_date: 2025-01-01.

Generate ONE file: workers/naelao-analytics/src/index.ts

Queue consumer that writes analytics events to CF Analytics Engine.

CRITICAL: Analytics Engine uses POSITIONAL fields (blob1-blob6, double1-double6).
ALWAYS use the AE schema registry constants, NEVER hardcode positions.

Env:
  NAELAO_ANALYTICS: AnalyticsEngineDataset
  NAELAO_CONFIG_KV: KVNamespace  (security event backup)
  NAELAO_DLQ: Queue

AE schema (MUST match packages/analytics-schema/src/index.ts):
  blobs[0]=event_type, blobs[1]=space_id, blobs[2]=agent_id, blobs[3]=model_id, blobs[4]=run_id, blobs[5]=billing_provider
  doubles[0]=credits_used, doubles[1]=duration_ms, doubles[2]=token_count, doubles[3]=amount_cents, doubles[4]=cache_hit_rate, doubles[5]=error_count

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
  trace_id?: string;  // G-F26 fix: distributed tracing
}

export default {
  async queue(batch: MessageBatch<AnalyticsEvent>, env: Env): Promise<void> {
    const points = batch.messages.map(msg => {
      const e = msg.body;
      // build blobs array using schema positions (G-F20 fix - no hardcoded numbers):
      const blobs: [string?,string?,string?,string?,string?,string?] = [
        e.event_type, e.space_id, e.agent_id, e.model_id, e.run_id, e.billing_provider,
      ];
      const doubles: [number?,number?,number?,number?,number?,number?] = [
        e.credits_used, e.duration_ms, e.token_count, e.amount_cents, undefined, undefined,
      ];
      return { blobs, doubles, indexes: [e.trace_id] };
    });
    
    try {
      await env.NAELAO_ANALYTICS.writeDataPoints(points);  // CRITICAL (G-I15 fix): MUST await — without await, catch never runs and DLQ fallback is bypassed
    } catch (err) {
      // DLQ for retry (G-G14 fix)
      await env.NAELAO_DLQ.sendBatch(batch.messages.map(m => ({ body: m.body })));
    }
    // CRITICAL (G-I14 fix): Use per-message ack/retry for the outer queue loop too.
    // The above try/catch handles the batch as a whole. For per-message granularity,
    // process messages individually with msg.ack() / msg.retry() inside the map.

    // SECURITY EVENT BACKUP (G-G14 fix): KV backup for security events
    for (const msg of batch.messages) {
      const e = msg.body;
      if (e.event_type?.startsWith('security_')) {
        await env.NAELAO_CONFIG_KV.put(
          'sec-event:' + Date.now() + ':' + e.event_type,
          JSON.stringify(e),
          { expirationTtl: 86400 * 30 }
        );
      }
    }
  }
}

