import type { WebhookIngressMessage, WebhookProvider } from "./ingress.js";

export interface ReplayLakeEnv {
  WEBHOOK_REPLAY_LAKE?: R2Bucket;
  WEBHOOK_INGRESS_QUEUE?: Queue<WebhookIngressMessage>;
  dispatchWebhook?(message: WebhookIngressMessage): Promise<void>;
  authorizeWebhookReplay?(request: Request, spaceId: string): Promise<boolean>;
}

export async function archiveWebhookEvent(
  env: ReplayLakeEnv,
  event: WebhookIngressMessage
): Promise<string | null> {
  if (!env.WEBHOOK_REPLAY_LAKE) return null;
  const key = `raw-webhooks/${encodeURIComponent(event.spaceId)}/${event.provider}/${encodeURIComponent(event.eventId)}.json`;
  const expiresAt = new Date(Date.now() + 14 * 86_400_000).toISOString();
  await env.WEBHOOK_REPLAY_LAKE.put(key, JSON.stringify(event), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      spaceId: event.spaceId,
      provider: event.provider,
      eventId: event.eventId,
      receivedAt: event.receivedAt,
      expiresAt,
    },
  });
  return key;
}

export async function replayWebhookEvent(
  env: ReplayLakeEnv,
  eventId: string,
  spaceId: string,
  provider: WebhookProvider
): Promise<WebhookIngressMessage> {
  if (!env.WEBHOOK_REPLAY_LAKE) throw new Error("replay_lake_unavailable");
  if (
    !spaceId ||
    spaceId.length > 256 ||
    !eventId ||
    eventId.length > 256 ||
    !["stripe", "github", "shopify"].includes(provider)
  ) {
    throw new Error("webhook_event_not_found");
  }
  const key = `raw-webhooks/${encodeURIComponent(spaceId)}/${provider}/${encodeURIComponent(eventId)}.json`;
  const stored = await env.WEBHOOK_REPLAY_LAKE.get(key);
  if (!stored) throw new Error("webhook_event_not_found");
  const event = await stored.json<WebhookIngressMessage>();
  if (
    event.spaceId !== spaceId ||
    event.eventId !== eventId ||
    !["stripe", "github", "shopify"].includes(event.provider)
  ) {
    throw new Error("webhook_event_not_found");
  }
  const replay = {
    ...event,
    replayed: true,
    receivedAt: new Date().toISOString(),
  };
  if (env.WEBHOOK_INGRESS_QUEUE) await env.WEBHOOK_INGRESS_QUEUE.send(replay);
  else if (env.dispatchWebhook) await env.dispatchWebhook(replay);
  else throw new Error("webhook_dispatch_unavailable");
  return replay;
}

export async function handleReplayRequest(
  request: Request,
  env: ReplayLakeEnv
): Promise<Response> {
  const match = new URL(request.url).pathname.match(
    /^\/webhooks\/replay\/([^/]+)$/
  );
  if (request.method !== "POST" || !match?.[1])
    return new Response("Not found", { status: 404 });
  const spaceId = new URL(request.url).searchParams.get("spaceId");
  if (!spaceId)
    return Response.json({ error_code: "space_id_required" }, { status: 400 });
  const provider = new URL(request.url).searchParams.get("provider");
  if (
    provider !== "stripe" &&
    provider !== "github" &&
    provider !== "shopify"
  ) {
    return Response.json({ error_code: "provider_required" }, { status: 400 });
  }
  let authorized = false;
  try {
    authorized =
      !!env.authorizeWebhookReplay &&
      (await env.authorizeWebhookReplay(request, spaceId));
  } catch {
    authorized = false;
  }
  if (!authorized) {
    return Response.json({ error_code: "replay_forbidden" }, { status: 403 });
  }
  try {
    const event = await replayWebhookEvent(
      env,
      decodeURIComponent(match[1]),
      spaceId,
      provider
    );
    return Response.json(
      { accepted: true, eventId: event.eventId },
      { status: 202 }
    );
  } catch (error) {
    const code = error instanceof Error ? error.message : "replay_failed";
    return Response.json(
      { error_code: code },
      { status: code === "webhook_event_not_found" ? 404 : 503 }
    );
  }
}
