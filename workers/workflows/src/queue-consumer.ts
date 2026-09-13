import type { Env } from "./env.js";

interface QueueMessage {
  type: string;
  [key: string]: unknown;
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
          await env.SPACE_PROVISIONING.create({
            id: message.id,
            params: body,
          });
          message.ack();
          break;

        case "data.erasure":
          await env.DATA_ERASURE.create({
            id: message.id,
            params: body,
          });
          message.ack();
          break;

        case "kb.ingest":
          if (typeof body.projectId !== "string" || !body.projectId) {
            throw new Error("kb.ingest requires projectId");
          }
          await env.KB_INGESTION.create({
            id: message.id,
            params: body,
          });
          message.ack();
          break;

        case "dunning":
          await env.DUNNING.create({
            id: message.id,
            params: body,
          });
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
