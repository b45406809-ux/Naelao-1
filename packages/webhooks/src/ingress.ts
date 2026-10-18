import { type ReplayLakeEnv, archiveWebhookEvent } from "./replay-lake.js";

export type WebhookProvider = "stripe" | "github" | "shopify";

export interface WebhookIngressMessage {
  type: "webhook_ingress";
  webhookId: string;
  spaceId: string;
  provider: WebhookProvider;
  eventId: string;
  eventType: string;
  payload: string;
  headers: Record<string, string>;
  receivedAt: string;
  replayed?: boolean;
}

export interface IngressEnv extends ReplayLakeEnv {
  WEBHOOK_TOMBSTONES?: KVNamespace;
  WEBHOOK_INGRESS_QUEUE?: Queue<WebhookIngressMessage>;
  dispatchWebhook?(message: WebhookIngressMessage): Promise<void>;
}

const encoder = new TextEncoder();
const MAX_WEBHOOK_BODY_BYTES = 1_048_576;
const SAFE_ARCHIVE_HEADERS = new Set([
  "content-type",
  "user-agent",
  "x-github-delivery",
  "x-github-event",
  "x-shopify-topic",
  "x-shopify-webhook-id",
  "stripe-version",
]);

class WebhookBodyTooLargeError extends Error {
  constructor() {
    super("webhook_body_too_large");
    this.name = "WebhookBodyTooLargeError";
  }
}

async function readBoundedBody(request: Request): Promise<Uint8Array> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_WEBHOOK_BODY_BYTES
  ) {
    throw new WebhookBodyTooLargeError();
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_WEBHOOK_BODY_BYTES) {
        await reader.cancel("webhook body exceeds limit");
        throw new WebhookBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function archiveHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries(
    [...headers.entries()]
      .filter(([name]) => SAFE_ARCHIVE_HEADERS.has(name.toLowerCase()))
      .map(([name, value]) => [name.toLowerCase(), value])
  );
}

function decodeHex(value: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) return null;
  return Uint8Array.from(value.match(/../g) ?? [], (byte) =>
    Number.parseInt(byte, 16)
  );
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Compares every expected byte even when the supplied signature has the wrong length. */
export function constantTimeEqual(
  expected: Uint8Array,
  supplied: Uint8Array | null
): boolean {
  const actual = supplied ?? new Uint8Array();
  let difference = expected.length ^ actual.length;
  for (let index = 0; index < expected.length; index++) {
    difference |= (expected[index] ?? 0) ^ (actual[index] ?? 0);
  }
  return difference === 0;
}

async function validatePayloadSignature(
  payload: Uint8Array,
  request: Request,
  secret: string,
  provider: WebhookProvider
): Promise<boolean> {
  let signedPayload = payload;
  let supplied: Uint8Array | null = null;
  if (provider === "stripe") {
    const values = request.headers.get("stripe-signature")?.split(",") ?? [];
    const timestamp = values.find((part) => part.startsWith("t="))?.slice(2);
    const signature =
      values.find((part) => part.startsWith("v1="))?.slice(3) ?? "";
    if (!timestamp || !/^\d{1,12}$/.test(timestamp)) return false;
    const timestampSeconds = Number(timestamp);
    if (
      !Number.isSafeInteger(timestampSeconds) ||
      Math.abs(Date.now() / 1000 - timestampSeconds) > 300
    )
      return false;
    const prefix = encoder.encode(`${timestamp}.`);
    signedPayload = new Uint8Array(prefix.byteLength + payload.byteLength);
    signedPayload.set(prefix);
    signedPayload.set(payload, prefix.byteLength);
    supplied = decodeHex(signature);
  } else if (provider === "github") {
    supplied = decodeHex(
      request.headers.get("x-hub-signature-256")?.replace(/^sha256=/, "") ?? ""
    );
  } else {
    supplied = decodeBase64(request.headers.get("x-shopify-hmac-sha256") ?? "");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, signedPayload)
  );
  return constantTimeEqual(expected, supplied);
}

export async function validateWebhookSignature(
  request: Request,
  secret: string,
  provider: WebhookProvider
): Promise<boolean> {
  try {
    return await validatePayloadSignature(
      await readBoundedBody(request.clone()),
      request,
      secret,
      provider
    );
  } catch {
    return false;
  }
}

export async function handleWebhookIngress(
  request: Request,
  env: IngressEnv,
  input: Omit<
    WebhookIngressMessage,
    "type" | "payload" | "headers" | "receivedAt"
  > & { secret: string }
): Promise<Response> {
  const tombstone = await env.WEBHOOK_TOMBSTONES?.get(
    `tombstone:${input.webhookId}`
  );
  if (tombstone === "deleted") return new Response(null, { status: 410 });
  if (tombstone === "paused") return new Response(null, { status: 204 });
  let rawPayload: Uint8Array;
  try {
    rawPayload = await readBoundedBody(request);
  } catch (error) {
    if (error instanceof WebhookBodyTooLargeError) {
      return Response.json(
        { error_code: "webhook_body_too_large" },
        { status: 413 }
      );
    }
    return Response.json(
      { error_code: "invalid_webhook_body" },
      { status: 400 }
    );
  }
  if (
    !(await validatePayloadSignature(
      rawPayload,
      request,
      input.secret,
      input.provider
    ))
  ) {
    return Response.json(
      { error_code: "invalid_webhook_signature" },
      { status: 401 }
    );
  }
  if (!env.WEBHOOK_INGRESS_QUEUE && !env.dispatchWebhook) {
    return Response.json(
      { error_code: "webhook_dispatch_unavailable" },
      { status: 503 }
    );
  }
  const payload = new TextDecoder().decode(rawPayload);
  const message: WebhookIngressMessage = {
    type: "webhook_ingress",
    webhookId: input.webhookId,
    spaceId: input.spaceId,
    provider: input.provider,
    eventId: input.eventId,
    eventType: input.eventType,
    payload,
    headers: archiveHeaders(request.headers),
    receivedAt: new Date().toISOString(),
  };
  await archiveWebhookEvent(env, message);
  if (env.WEBHOOK_INGRESS_QUEUE) await env.WEBHOOK_INGRESS_QUEUE.send(message);
  else await env.dispatchWebhook?.(message);
  return Response.json(
    { accepted: true, eventId: input.eventId },
    { status: 202 }
  );
}
