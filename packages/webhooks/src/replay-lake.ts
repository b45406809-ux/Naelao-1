import type { WebhookIngressMessage } from "./ingress.js";

export interface ReplayLakeEnv { WEBHOOK_REPLAY_LAKE?: R2Bucket; WEBHOOK_INGRESS_QUEUE?: Queue<WebhookIngressMessage>; dispatchWebhook?(message: WebhookIngressMessage): Promise<void>; }

export async function archiveWebhookEvent(env: ReplayLakeEnv, event: WebhookIngressMessage): Promise<string | null> {
  if (!env.WEBHOOK_REPLAY_LAKE) return null;
  const key = `raw-webhooks/${event.spaceId}/${event.provider}/${encodeURIComponent(event.eventId)}.json`;
  const expiresAt = new Date(Date.now() + 14 * 86_400_000).toISOString();
  await env.WEBHOOK_REPLAY_LAKE.put(key, JSON.stringify(event), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { spaceId: event.spaceId, provider: event.provider, eventId: event.eventId, receivedAt: event.receivedAt, expiresAt },
  });
  return key;
}

export async function replayWebhookEvent(env: ReplayLakeEnv, eventId: string, spaceId?: string): Promise<WebhookIngressMessage> {
  if (!env.WEBHOOK_REPLAY_LAKE) throw new Error("replay_lake_unavailable");
  let cursor: string | undefined;
  let object: R2Object | undefined;
  do {
    const page = await env.WEBHOOK_REPLAY_LAKE.list({ prefix: spaceId ? `raw-webhooks/${spaceId}/` : "raw-webhooks/", ...(cursor ? { cursor } : {}) });
    object = page.objects.find((item) => item.key.endsWith(`/${encodeURIComponent(eventId)}.json`));
    cursor = page.truncated ? page.cursor : undefined;
  } while (!object && cursor);
  if (!object) throw new Error("webhook_event_not_found");
  const stored = await env.WEBHOOK_REPLAY_LAKE.get(object.key);
  if (!stored) throw new Error("webhook_event_not_found");
  const event = await stored.json<WebhookIngressMessage>();
  const replay = { ...event, replayed: true, receivedAt: new Date().toISOString() };
  if (env.WEBHOOK_INGRESS_QUEUE) await env.WEBHOOK_INGRESS_QUEUE.send(replay);
  else if (env.dispatchWebhook) await env.dispatchWebhook(replay);
  else throw new Error("webhook_dispatch_unavailable");
  return replay;
}

export async function handleReplayRequest(request: Request, env: ReplayLakeEnv): Promise<Response> {
  const match = new URL(request.url).pathname.match(/^\/webhooks\/replay\/([^/]+)$/);
  if (request.method !== "POST" || !match?.[1]) return new Response("Not found", { status: 404 });
  try {
    const event = await replayWebhookEvent(env, decodeURIComponent(match[1]), new URL(request.url).searchParams.get("spaceId") ?? undefined);
    return Response.json({ accepted: true, eventId: event.eventId }, { status: 202 });
  } catch (error) {
    const code = error instanceof Error ? error.message : "replay_failed";
    return Response.json({ error_code: code }, { status: code === "webhook_event_not_found" ? 404 : 503 });
  }
}
