import { Hono } from "hono";
import { errorResponse } from "@naelao/http";
import { WebhookRegistrationRecord, WebhookReplayRequest } from "@naelao/types";

export const webhookAdminRouter = new Hono<{ Bindings: Env }>();

/**
 * Register or Update a Webhook Endpoint
 * POST /spaces/:spaceId/projects/:projectId/webhooks
 */
webhookAdminRouter.post("/spaces/:spaceId/projects/:projectId/webhooks", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const body = await c.req.json() as {
    triggerSlug: string;
    workflowId: string;
    provider: string;
    secretKey?: string;
  };

  const secretKey = body.secretKey || `whsec_${crypto.randomUUID().replace(/-/g, "")}`;
  const record: WebhookRegistrationRecord = {
    spaceId,
    projectId,
    triggerSlug: body.triggerSlug,
    workflowId: body.workflowId,
    status: "ACTIVE",
    provider: body.provider as any,
    secretKey,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  // 1. Sync registration to Edge KV for <1ms routing
  await c.env.WEBHOOK_TOMBSTONES_KV.put(
    `hook:${spaceId}:${body.triggerSlug}`,
    JSON.stringify(record)
  );

  // 2. Generate Public Ingress URL
  const publicUrl = `https://api.naelao.com/v1/webhooks/${spaceId}/${body.triggerSlug}`;

  return c.json({
    ok: true,
    registration: record,
    publicWebhookUrl: publicUrl,
    secretKey
  });
});

/**
 * Pause or Delete a Webhook (Tombstone Activation)
 * PATCH /spaces/:spaceId/webhooks/:triggerSlug/status
 */
webhookAdminRouter.patch("/spaces/:spaceId/webhooks/:triggerSlug/status", async (c) => {
  const { spaceId, triggerSlug } = c.req.param();
  const { status } = await c.req.json() as { status: "ACTIVE" | "PAUSED" | "DELETED" };

  const key = `hook:${spaceId}:${triggerSlug}`;
  const existing = await c.env.WEBHOOK_TOMBSTONES_KV.get<WebhookRegistrationRecord>(key, "json");

  if (!existing) {
    return errorResponse(c, 404, "webhook_not_found", "Webhook registration not found");
  }

  existing.status = status;
  existing.updatedAt = new Date().toISOString();

  await c.env.WEBHOOK_TOMBSTONES_KV.put(key, JSON.stringify(existing));
  return c.json({ ok: true, status: existing.status });
});

/**
 * Time-Travel Event Replay
 * POST /spaces/:spaceId/webhooks/replay
 */
webhookAdminRouter.post("/spaces/:spaceId/webhooks/replay", async (c) => {
  const { spaceId } = c.req.param();
  const { eventId, targetWorkflowId } = await c.req.json() as WebhookReplayRequest;

  // Search R2 lake for the historical payload
  const list = await c.env.WEBHOOK_LAKE_R2.list({ prefix: `webhooks/${spaceId}/` });
  const matchedObject = list.objects.find(obj => obj.key.endsWith(`${eventId}.json`));

  if (!matchedObject) {
    return errorResponse(c, 404, "event_not_found", "Historical webhook payload not found in R2 lake");
  }

  const file = await c.env.WEBHOOK_LAKE_R2.get(matchedObject.key);
  if (!file) {
    return errorResponse(c, 500, "r2_read_failed", "Failed to retrieve payload from R2");
  }

  const rawText = await file.text();
  const payload = JSON.parse(rawText);

  // Re-enqueue into the queue as an official replayed event
  const replayedEvent = {
    eventId: `replay_${Date.now()}_${eventId}`,
    spaceId,
    projectId: file.customMetadata?.projectId || "",
    triggerSlug: file.customMetadata?.triggerSlug || "replay",
    workflowId: targetWorkflowId || "default_workflow",
    provider: (file.customMetadata?.provider || "generic_hmac") as any,
    signature: "replayed_by_admin",
    headers: { "x-avos-replayed": "true" },
    payload,
    rawBodyR2Key: matchedObject.key,
    receivedAt: new Date().toISOString(),
    attemptCount: 1
  };

  await c.env.AUTOMATIONS_QUEUE.send(replayedEvent);

  return c.json({
    ok: true,
    replayedEventId: replayedEvent.eventId,
    message: "Historical event successfully replayed into the automation pipeline."
  });
});
