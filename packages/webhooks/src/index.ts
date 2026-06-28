// Outbound webhook signing (HMAC-SHA256), delivery queue publishing, retry state

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
  send(msg: WebhookQueueMessage): Promise<void>;
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
export async function signWebhookPayload(payload: string, secret: string, timestamp: number): Promise<string> {
  const signingInput = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  const hexSig = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${timestamp},v1=${hexSig}`;
}

// Verify an inbound webhook signature
export async function verifyWebhookSignature(
  payload: string,
  signatureHeader: string,
  secret: string,
  toleranceSeconds = 300
): Promise<boolean> {
  const parts = Object.fromEntries(signatureHeader.split(",").map((p) => p.split("=")));
  const timestamp = parseInt(parts["t"] ?? "0", 10);
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;
  const expectedSig = await signWebhookPayload(payload, secret, timestamp);
  const expected = expectedSig.split(",v1=")[1] ?? "";
  const received = parts["v1"] ?? "";
  if (expected.length !== received.length) return false;
  const expBuf = hexToBuf(expected);
  const recBuf = hexToBuf(received);
  let diff = 0;
  for (let i = 0; i < expBuf.length; i++) diff |= (expBuf[i] ?? 0) ^ (recBuf[i] ?? 0);
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

  await db.prepare(
    `INSERT INTO webhook_deliveries (id, subscription_id, tenant_id, event_type, payload, status, attempt_count, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`
  ).bind(deliveryId, subscription.id, subscription.tenant_id, eventType, payloadStr, now, now, now).run();

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
const RETRY_DELAYS_SECONDS = [0, 30, 60, 300, 1800]; // 5 attempts

export async function deliverWebhook(
  msg: WebhookQueueMessage,
  queue: WebhookQueue,
  db: D1Database
): Promise<void> {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await signWebhookPayload(msg.payload, msg.secret, timestamp);
  try {
    const resp = await fetch(msg.url, {
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
    if (resp.ok) {
      await db.prepare(
        "UPDATE webhook_deliveries SET status = 'delivered', attempt_count = ?, updated_at = ? WHERE id = ?"
      ).bind(msg.attempt, new Date().toISOString(), msg.delivery_id).run();
      return;
    }
    throw new Error(`HTTP ${resp.status}`);
  } catch (err) {
    const nextAttempt = msg.attempt + 1;
    const delaySeconds = RETRY_DELAYS_SECONDS[nextAttempt] ?? null;
    const now = new Date().toISOString();
    if (delaySeconds !== null) {
      const nextAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
      await db.prepare(
        "UPDATE webhook_deliveries SET attempt_count = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?"
      ).bind(nextAttempt, nextAt, String(err), now, msg.delivery_id).run();
      // Re-enqueue with delay
      await queue.send({ ...msg, attempt: nextAttempt });
    } else {
      await db.prepare(
        "UPDATE webhook_deliveries SET status = 'failed', attempt_count = ?, last_error = ?, updated_at = ? WHERE id = ?"
      ).bind(nextAttempt, String(err), now, msg.delivery_id).run();
    }
  }
}

function hexToBuf(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}
