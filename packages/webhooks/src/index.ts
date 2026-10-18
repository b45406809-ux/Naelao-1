// Outbound webhook signing (HMAC-SHA256), delivery queue publishing, retry state
import { checkSsrf } from "@naelao/security";

export interface WebhookSubscription {
  id: string;
  tenant_id: string;
  url: string;
  events: string[];
  secret: string;
  enabled: boolean;
  created_at: string;
}

export interface WebhookDelivery {
  id: string;
  subscription_id: string;
  tenant_id: string;
  event_type: string;
  payload: string;
  status: "pending" | "delivered" | "failed";
  attempt_count: number;
  next_attempt_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface WebhookQueue {
  send(
    msg: WebhookQueueMessage,
    options?: { delaySeconds: number }
  ): Promise<void>;
}

export interface WebhookQueueMessage {
  type: "webhook_delivery";
  delivery_id: string;
  subscription_id: string;
  tenant_id: string;
  url: string;
  secret: string;
  event_type: string;
  payload: string;
  attempt: number;
}

// Sign a webhook payload with HMAC-SHA256
export async function signWebhookPayload(
  payload: string,
  secret: string,
  timestamp: number
): Promise<string> {
  const signingInput = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signingInput)
  );
  const hexSig = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `t=${timestamp},v1=${hexSig}`;
}

// Verify an inbound webhook signature
export async function verifyWebhookSignature(
  payload: string,
  signatureHeader: string,
  secret: string,
  toleranceSeconds = 300
): Promise<boolean> {
  if (!Number.isFinite(toleranceSeconds) || toleranceSeconds < 0) return false;
  const match = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/i.exec(signatureHeader);
  if (!match?.[1] || !match[2]) return false;
  const timestamp = Number(match[1]);
  if (
    !Number.isSafeInteger(timestamp) ||
    Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds
  )
    return false;
  const expectedSig = await signWebhookPayload(payload, secret, timestamp);
  const expected = expectedSig.split(",v1=")[1] ?? "";
  const received = match[2];
  const expBuf = hexToBuf(expected);
  const recBuf = hexToBuf(received);
  let diff = 0;
  for (let i = 0; i < expBuf.length; i++)
    diff |= (expBuf[i] ?? 0) ^ (recBuf[i] ?? 0);
  return diff === 0;
}

// Enqueue a webhook delivery
export async function enqueueWebhook(
  queue: WebhookQueue,
  db: D1Database,
  subscription: WebhookSubscription,
  eventType: string,
  payload: unknown
): Promise<string> {
  const deliveryId = crypto.randomUUID();
  const now = new Date().toISOString();
  const payloadStr = JSON.stringify(payload);

  await db
    .prepare(
      `INSERT INTO webhook_deliveries (id, subscription_id, event_type, payload_json, status, attempt_count, next_attempt_at, created_at)
     VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`
    )
    .bind(deliveryId, subscription.id, eventType, payloadStr, now, now)
    .run();

  await queue.send({
    type: "webhook_delivery",
    delivery_id: deliveryId,
    subscription_id: subscription.id,
    tenant_id: subscription.tenant_id,
    url: subscription.url,
    secret: subscription.secret,
    event_type: eventType,
    payload: payloadStr,
    attempt: 1,
  });

  return deliveryId;
}

// Deliver a webhook with retry backoff
const RETRY_DELAYS_SECONDS = [30, 60, 300, 1800]; // Initial attempt plus four retries
const MAX_WEBHOOK_REDIRECTS = 5;

class WebhookPolicyError extends Error {}

async function fetchWebhook(url: string, init: RequestInit): Promise<Response> {
  let target = url;
  for (let redirects = 0; redirects <= MAX_WEBHOOK_REDIRECTS; redirects++) {
    const check = await checkSsrf(target);
    if (check.blocked)
      throw new WebhookPolicyError("webhook_destination_blocked");
    const response = await fetch(target, { ...init, redirect: "manual" });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location || redirects === MAX_WEBHOOK_REDIRECTS) {
      throw new WebhookPolicyError("webhook_redirect_limit_exceeded");
    }
    try {
      target = new URL(location, target).toString();
    } catch {
      throw new WebhookPolicyError("webhook_redirect_invalid");
    }
  }
  throw new WebhookPolicyError("webhook_redirect_limit_exceeded");
}

export async function deliverWebhook(
  msg: WebhookQueueMessage,
  queue: WebhookQueue,
  db: D1Database
): Promise<void> {
  if (
    !Number.isSafeInteger(msg.attempt) ||
    msg.attempt < 1 ||
    msg.attempt > 5
  ) {
    throw new Error("invalid_webhook_attempt");
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await signWebhookPayload(
    msg.payload,
    msg.secret,
    timestamp
  );
  let response: Response;
  try {
    response = await fetchWebhook(msg.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Naelao-Signature": signature,
        "X-Naelao-Event": msg.event_type,
        "X-Naelao-Delivery": msg.delivery_id,
      },
      body: msg.payload,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    if (error instanceof WebhookPolicyError) {
      await db
        .prepare(
          "UPDATE webhook_deliveries SET status = 'failed', attempt_count = ?, next_attempt_at = NULL, last_response_status = NULL WHERE id = ?"
        )
        .bind(msg.attempt, msg.delivery_id)
        .run();
      return;
    }
    await scheduleRetry(msg, queue, db, null);
    return;
  }
  if (response.ok) {
    await response.body?.cancel().catch(() => undefined);
    await db
      .prepare(
        "UPDATE webhook_deliveries SET status = 'delivered', attempt_count = ?, next_attempt_at = NULL, last_response_status = ?, delivered_at = ? WHERE id = ?"
      )
      .bind(
        msg.attempt,
        response.status,
        new Date().toISOString(),
        msg.delivery_id
      )
      .run();
    return;
  }
  await response.body?.cancel().catch(() => undefined);
  await scheduleRetry(msg, queue, db, response.status);
}

async function scheduleRetry(
  msg: WebhookQueueMessage,
  queue: WebhookQueue,
  db: D1Database,
  responseStatus: number | null
): Promise<void> {
  const nextAttempt = msg.attempt + 1;
  const delaySeconds = RETRY_DELAYS_SECONDS[msg.attempt - 1];
  if (delaySeconds !== undefined) {
    const nextAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
    await db
      .prepare(
        "UPDATE webhook_deliveries SET attempt_count = ?, next_attempt_at = ?, last_response_status = ? WHERE id = ?"
      )
      .bind(nextAttempt, nextAt, responseStatus, msg.delivery_id)
      .run();
    await queue.send({ ...msg, attempt: nextAttempt }, { delaySeconds });
    return;
  }
  await db
    .prepare(
      "UPDATE webhook_deliveries SET status = 'failed', attempt_count = ?, next_attempt_at = NULL, last_response_status = ? WHERE id = ?"
    )
    .bind(nextAttempt, responseStatus, msg.delivery_id)
    .run();
}

function hexToBuf(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

export * from "./ingress.js";
export * from "./replay-lake.js";
export * from "./lenient-zod.js";
export * from "./schema-repair.js";
