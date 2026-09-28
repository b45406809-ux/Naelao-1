import { archiveWebhookEvent, type ReplayLakeEnv } from "./replay-lake.js";

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

function decodeHex(value: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) return null;
  return Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch { return null; }
}

/** Compares every expected byte even when the supplied signature has the wrong length. */
export function constantTimeEqual(expected: Uint8Array, supplied: Uint8Array | null): boolean {
  const actual = supplied ?? new Uint8Array();
  let difference = expected.length ^ actual.length;
  for (let index = 0; index < expected.length; index++) {
    difference |= (expected[index] ?? 0) ^ (actual[index] ?? 0);
  }
  return difference === 0;
}

export async function validateWebhookSignature(request: Request, secret: string, provider: WebhookProvider): Promise<boolean> {
  const payload = await request.clone().text();
  let signedPayload = payload;
  let supplied: Uint8Array | null = null;
  if (provider === "stripe") {
    const values = request.headers.get("stripe-signature")?.split(",") ?? [];
    const timestamp = values.find((part) => part.startsWith("t="))?.slice(2);
    const signature = values.find((part) => part.startsWith("v1="))?.slice(3) ?? "";
    if (!timestamp || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
    signedPayload = `${timestamp}.${payload}`;
    supplied = decodeHex(signature);
  } else if (provider === "github") {
    supplied = decodeHex(request.headers.get("x-hub-signature-256")?.replace(/^sha256=/, "") ?? "");
  } else {
    supplied = decodeBase64(request.headers.get("x-shopify-hmac-sha256") ?? "");
  }
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(signedPayload)));
  return constantTimeEqual(expected, supplied);
}

export async function handleWebhookIngress(request: Request, env: IngressEnv, input: Omit<WebhookIngressMessage, "type" | "payload" | "headers" | "receivedAt"> & { secret: string }): Promise<Response> {
  const tombstone = await env.WEBHOOK_TOMBSTONES?.get(`tombstone:${input.webhookId}`);
  if (tombstone === "deleted") return new Response(null, { status: 410 });
  if (tombstone === "paused") return new Response(null, { status: 204 });
  if (!(await validateWebhookSignature(request, input.secret, input.provider))) {
    return Response.json({ error_code: "invalid_webhook_signature" }, { status: 401 });
  }
  const payload = await request.text();
  const message: WebhookIngressMessage = {
    type: "webhook_ingress", webhookId: input.webhookId, spaceId: input.spaceId,
    provider: input.provider, eventId: input.eventId, eventType: input.eventType, payload,
    headers: Object.fromEntries(request.headers), receivedAt: new Date().toISOString(),
  };
  await archiveWebhookEvent(env, message);
  if (env.WEBHOOK_INGRESS_QUEUE) await env.WEBHOOK_INGRESS_QUEUE.send(message);
  else if (env.dispatchWebhook) await env.dispatchWebhook(message);
  else return Response.json({ error_code: "webhook_dispatch_unavailable" }, { status: 503 });
  return Response.json({ accepted: true, eventId: input.eventId }, { status: 202 });
}
