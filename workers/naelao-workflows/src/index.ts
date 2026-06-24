import { verifyInternalToken } from '../../naelao-auth/src/jwt';

interface WorkflowDispatchMessage {
  workflowId: string;
  spaceId: string;
  authToken?: string;
  triggeredBy: 'schedule' | 'webhook' | 'manual';
  payload?: unknown;
}

interface Env {
  NAELAO_SPACE_DO: DurableObjectNamespace;
  NAELAO_WORKFLOW_R2: R2Bucket;
  NAELAO_CONFIG_KV: KVNamespace;
  NAELAO_CIRCUIT_KV: KVNamespace;
  NAELAO_ANALYTICS: AnalyticsEngineDataset;
  NAELAO_JWT_SECRET: string;
  DISPATCH_NAMESPACE: DispatchNamespace;
}

export default {
  async queue(batch: MessageBatch<WorkflowDispatchMessage>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      const { workflowId, spaceId, authToken, triggeredBy } = msg.body;

      if (authToken) {
        try {
          const claims = await verifyInternalToken(authToken, env.NAELAO_JWT_SECRET) as {
            spaceId?: string; workflowId?: string;
          };
          if (claims.spaceId !== spaceId || claims.workflowId !== workflowId) {
            env.NAELAO_ANALYTICS.writeDataPoint({
              blobs: ['security_workflow_auth_mismatch', spaceId, workflowId],
              doubles: [],
            });
            msg.ack();
            continue;
          }
        } catch {
          env.NAELAO_ANALYTICS.writeDataPoint({
            blobs: ['security_workflow_invalid_token', spaceId, workflowId],
            doubles: [],
          });
          msg.ack();
          continue;
        }
      }

      const codeKey = 'spaces/' + spaceId + '/workflows/' + workflowId + '.js';
      const codeObj = await env.NAELAO_WORKFLOW_R2.get(codeKey);
      if (!codeObj) {
        msg.ack();
        continue;
      }

      try {
        const worker = env.DISPATCH_NAMESPACE.get(spaceId + '-' + workflowId);
        await worker.fetch(new Request('https://workflow/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(msg.body),
        }));

        env.NAELAO_ANALYTICS.writeDataPoint({
          blobs: ['workflow_executed', spaceId, workflowId, triggeredBy],
          doubles: [],
        });
        msg.ack();
      } catch (e) {
        env.NAELAO_ANALYTICS.writeDataPoint({
          blobs: ['workflow_execution_failed', spaceId, workflowId, String(e)],
          doubles: [],
        });
        msg.retry();
      }
    }
  },
};
