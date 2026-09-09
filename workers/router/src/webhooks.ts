import { Hono } from "hono";
import { InboundWebhookEnvelope, WebhookRegistrationRecord } from "@naelao/types";

export interface WebhookRouterEnv {
  WEBHOOK_TOMBSTONES_KV: KVNamespace;
  WEBHOOK_LAKE_R2: R2Bucket;
  AUTOMATIONS_QUEUE: Queue<InboundWebhookEnvelope>;
  PLATFORM_SECRET: string;
}

export const webhookRouter = new Hono<{ Bindings: WebhookRouterEnv }>();

/**
 * Timing-safe HMAC-SHA256 signature verification.
 */
async function verifyHmacSignature(rawBody: string, signature: string, secret: string, provider: string): Promise<boolean> {
  if (!signature || !secret) return false;

  try {
    const encoder = new TextEncoder();
    let cleanedSignature = signature;

    // Handle provider-specific header formatting
    if (provider === "stripe" && signature.includes("t=")) {
      const parts = signature.split(",");
      const v1Sig = parts.find(p => p.startsWith("v1="));
      if (!v1Sig) return false;
      cleanedSignature = v1Sig.replace("v1=", "").trim();
    } else if (provider === "github" && signature.startsWith("sha256=")) {
      cleanedSignature = signature.replace("sha256=", "").trim();
    }

    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    // Convert hex signature to binary array buffer
    const sigBytes = new Uint8Array(
      cleanedSignature.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []
    );

    return await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes,
      encoder.encode(rawBody)
    );
  } catch {
    return false;
  }
}

/**
 * Main Webhook Ingress Route
 * POST /v1/webhooks/:spaceId/:triggerSlug
 */
webhookRouter.post("/v1/webhooks/:spaceId/:triggerSlug", async (c) => {
  const { spaceId, triggerSlug } = c.req.param();
  const rawBody = await c.req.text();

  // 1. Edge Tombstone & Registration Lookup (Sub-1ms in KV)
  const registrationKey = `hook:${spaceId}:${triggerSlug}`;
  const registration = await c.env.WEBHOOK_TOMBSTONES_KV.get<WebhookRegistrationRecord>(registrationKey, "json");

  // Handle deleted or unmapped webhook endpoints immediately
  if (!registration || registration.status === "DELETED") {
    // 410 Gone tells Stripe/GitHub/Shopify to permanently stop sending events
    return c.text("Webhook Endpoint Deleted or Inactive", 410);
  }

  // Handle paused automations with $0 compute overhead
  if (registration.status === "PAUSED") {
    // 204 No Content acknowledges receipt without enqueuing work or running workflows
    return c.text("Webhook Paused", 204);
  }

  // 2. Extract Signature from Provider Headers
  const signature = 
    c.req.header("x-hub-signature-256") || // GitHub
    c.req.header("stripe-signature") ||     // Stripe
    c.req.header("x-shopify-hmac-sha256") || // Shopify
    c.req.header("svix-signature") ||       // Svix / AgentMail
    c.req.header("x-webhook-signature") ||  // Generic
    "";

  // 3. Cryptographic Signature Validation
  const isValidSignature = await verifyHmacSignature(
    rawBody,
    signature,
    registration.secretKey,
    registration.provider
  );

  if (!isValidSignature) {
    return c.json({ error: "Invalid cryptographic webhook signature" }, 401);
  }

  // 4. Archive Raw Payload into R2 Time-Travel Lake (14-day retention)
  const now = new Date();
  const datePath = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${String(now.getUTCDate()).padStart(2, "0")}`;
  const eventId = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const r2Key = `webhooks/${spaceId}/${datePath}/${eventId}.json`;

  let parsedPayload: Record<string, any> = {};
  try {
    parsedPayload = JSON.parse(rawBody);
  } catch {
    parsedPayload = { _rawText: rawBody };
  }

  await c.env.WEBHOOK_LAKE_R2.put(r2Key, rawBody, {
    customMetadata: {
      spaceId,
      projectId: registration.projectId,
      triggerSlug,
      provider: registration.provider,
      receivedAt: now.toISOString()
    }
  });

  // 5. Enqueue into Cloudflare Queue to Buffer Concurrency
  const envelope: InboundWebhookEnvelope = {
    eventId,
    spaceId,
    projectId: registration.projectId,
    triggerSlug,
    workflowId: registration.workflowId,
    provider: registration.provider,
    signature,
    headers: c.req.header(),
    payload: parsedPayload,
    rawBodyR2Key: r2Key,
    receivedAt: now.toISOString(),
    attemptCount: 1
  };

  await c.env.AUTOMATIONS_QUEUE.send(envelope);

  // Return clean receipt confirmation to the external caller
  return c.json({
    ok: true,
    eventId,
    status: "ENQUEUED",
    timestamp: now.toISOString()
  });
});
