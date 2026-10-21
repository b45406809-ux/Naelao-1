import type { Env } from "./env.js";

interface QueueMessage {
  type: string;
  [key: string]: unknown;
}

async function createWorkflowOnce(
  workflow: Env["SPACE_PROVISIONING"],
  id: string,
  params: Record<string, unknown>
): Promise<void> {
  try {
    await workflow.create({ id, params });
  } catch (createError) {
    // Queue delivery is at least once. If create succeeded but its response or our later
    // acknowledgement was lost, the same message is redelivered and create reports a conflict.
    // Confirm the deterministic instance exists before treating that redelivery as handled.
    try {
      const instance = await workflow.get(id);
      if (!instance) throw createError;
    } catch {
      throw createError;
    }
  }
}

export async function queue(
  batch: MessageBatch<QueueMessage>,
  env: Env
): Promise<void> {
  for (const message of batch.messages) {
    const body = message.body;
    try {
      switch (body.type) {
        case "space.provision":
          await createWorkflowOnce(env.SPACE_PROVISIONING, message.id, body);
          message.ack();
          break;

        case "data.erasure":
          if (typeof body.orgId !== "string" || !body.orgId || body.orgId.length > 128 ||
              typeof body.requestedBy !== "string" || !body.requestedBy || body.requestedBy.length > 256 ||
              typeof body.reason !== "string" || body.reason.length > 2000 ||
              typeof body.requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.requestId)) {
            console.warn(`[queue] discarding malformed data.erasure message ${message.id}`);
            message.ack();
            break;
          }
          await createWorkflowOnce(env.DATA_ERASURE, message.id, body);
          message.ack();
          break;

        case "kb.ingest":
          if (typeof body.docId !== "string" || !body.docId || typeof body.spaceId !== "string" || !body.spaceId ||
              typeof body.tenantId !== "string" || !body.tenantId || typeof body.projectId !== "string" || !body.projectId ||
              typeof body.r2Key !== "string" || !body.r2Key || typeof body.title !== "string" || !body.title ||
              typeof body.contentType !== "string" || !body.contentType ||
              (body.requiredRoleRank !== undefined && (!Number.isSafeInteger(body.requiredRoleRank) || Number(body.requiredRoleRank) < 0 || Number(body.requiredRoleRank) > 50)) ||
              (body.allowedUserIds !== undefined && (!Array.isArray(body.allowedUserIds) || body.allowedUserIds.length > 100 ||
                body.allowedUserIds.some((id) => typeof id !== "string" || !id || id.length > 256)))) {
            throw new Error("kb.ingest requires valid document scope, staging key, and access policy");
          }
          const activeSpace = await env.PLATFORM_DB.prepare(
            `SELECT s.id FROM spaces s JOIN orgs o ON o.id = s.tenant_id AND o.status = 'active'
             WHERE s.id = ? AND s.tenant_id = ? AND s.status = 'active'`,
          ).bind(body.spaceId, body.tenantId).first<{ id: string }>();
          if (!activeSpace) {
            console.warn(`[queue] dropping stale KB ingestion for inactive tenant/space ${body.tenantId}/${body.spaceId}`);
            message.ack();
            break;
          }
          await createWorkflowOnce(env.KB_INGESTION, message.id, body);
          message.ack();
          break;

        case "dunning":
          await createWorkflowOnce(env.DUNNING, message.id, body);
          message.ack();
          break;

        default:
          // Unknown event types are acknowledged without processing
          // Analytics events are handled by the analytics worker queue consumer
          if (typeof body.type === "string" && body.type.startsWith("analytics.")) {
            console.log(`[queue] analytics event (handled by analytics worker): ${body.type}`);
          } else {
            console.warn(`[queue] unknown event type: ${body.type} — discarding`);
          }
          message.ack();
      }
    } catch (err) {
      console.error(`[queue] error processing message ${message.id} type=${body.type}:`, err);
      message.retry();
    }
  }
}
