# Prompt: workers/naelao-workflows/src/index.ts

---
## PASTE THIS ENTIRE BLOCK INTO YOUR FREE AI
---

Naelao = multi-tenant AI agent builder on Cloudflare Workers + Durable Objects. NO Node.js, NO PostgreSQL. Data in SpaceDO SQLite. Service Bindings for Worker comms. Hono for routing. JWT auth. Errors: { error: { code: 'SNAKE_CASE', message: 'text' } }. All routes /v1/. compatibility_date: 2025-01-01.

Generate ONE file: workers/naelao-workflows/src/index.ts

Queue consumer for workflow dispatch. Loads workflow code from R2 and executes via CF Workers for Platforms.

CRITICAL (G-F04 fix): MUST verify spaceId cryptographically before loading code:
  - SpaceId in queue message must match HMAC token stored at registration time
  - Use: verifyInternalToken(msg.authToken, env.NAELAO_JWT_SECRET) and check spaceId matches

Env:
  NAELAO_SPACE_DO: DurableObjectNamespace
  NAELAO_WORKFLOW_R2: R2Bucket  (workflow code storage)
  NAELAO_CONFIG_KV: KVNamespace
  NAELAO_ANALYTICS: AnalyticsEngineDataset
  NAELAO_JWT_SECRET: string
  DISPATCH_NAMESPACE: DispatchNamespace  (CF Workers for Platforms)

interface WorkflowDispatchMessage {
  workflowId: string;
  spaceId: string;
  authToken: string;  // HMAC token binding spaceId to this workflow
  triggeredBy: 'schedule' | 'webhook' | 'manual';
  payload?: unknown;
}

export default {
  async queue(batch: MessageBatch<WorkflowDispatchMessage>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      const { workflowId, spaceId, authToken } = msg.body;
      
      // CRITICAL (G-F04 fix): verify spaceId is cryptographically bound to this workflow
      try {
        const claims = await verifyInternalToken(authToken, env.NAELAO_JWT_SECRET);
        if (claims.spaceId !== spaceId || claims.workflowId !== workflowId) {
          // Log security event and skip
          continue;
        }
      } catch { continue; }
      
      // Load workflow code from R2
      const codeKey = 'spaces/' + spaceId + '/workflows/' + workflowId + '.js';
      const codeObj = await env.NAELAO_WORKFLOW_R2.get(codeKey);
      if (!codeObj) continue;
      const code = await codeObj.text();
      
      // Execute via CF Workers for Platforms dispatch namespace
      // eval() and dynamic import() are prohibited - MUST use dispatch namespace
      const worker = env.DISPATCH_NAMESPACE.get(spaceId + '-' + workflowId, {}, { outbound: ... });
      await worker.fetch(new Request('https://workflow/', { method:'POST', body: JSON.stringify(msg.body) }));
    }
  }
}

