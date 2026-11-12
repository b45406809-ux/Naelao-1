import { isCurrentAgentPortSubscription, type AgentPortSubscriptionState } from "./agentport-event-subscription.js";
import type { ProviderEventReferenceQueueMessage } from "./session-queue.js";

export interface AgentPortProviderEventDispatchDeps {
  currentSubscription(event: ProviderEventReferenceQueueMessage): Promise<AgentPortSubscriptionState | null>;
  resolveAssistant(event: ProviderEventReferenceQueueMessage): Promise<{ assistantId: string; wakeEnabled: boolean; routeRevision: number } | null>;
  persistAssistant(event: ProviderEventReferenceQueueMessage, route: { assistantId: string; wakeEnabled: boolean; routeRevision: number }): Promise<string | null>;
  stableSessionId(event: ProviderEventReferenceQueueMessage, assistantId: string): Promise<string>;
  persistSessionId(event: ProviderEventReferenceQueueMessage, sessionId: string): Promise<void>;
  ensureSession(event: ProviderEventReferenceQueueMessage, sessionId: string, assistantId: string): Promise<void>;
  appendReference(event: ProviderEventReferenceQueueMessage, sessionId: string, reference: Record<string, string>): Promise<void>;
  wake(input: { event: ProviderEventReferenceQueueMessage; sessionId: string; assistantId: string; runId: string; reference: Record<string, string> }): Promise<boolean>;
  markAccepted(event: ProviderEventReferenceQueueMessage): Promise<void>;
  markFailed(event: ProviderEventReferenceQueueMessage): Promise<void>;
}

export async function stableAgentPortEventRunId(event: ProviderEventReferenceQueueMessage, assistantId: string): Promise<string> {
  const identity = `${event.tenantId}\0${event.spaceId}\0${event.deliveryId}\0${assistantId}`;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity)));
  return `agentport-event-${Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Dispatches only a provider reference after rechecking the current AgentPort subscription.
 * Message bodies and attachment contents remain in the provider channel and are never queued. */
export async function dispatchAgentPortProviderEvent(
  event: ProviderEventReferenceQueueMessage,
  deps: AgentPortProviderEventDispatchDeps,
): Promise<void> {
  const current = await deps.currentSubscription(event);
  if (!isCurrentAgentPortSubscription({
    subscriptionId: event.subscriptionId,
    agentId: event.agentId,
    accountId: event.accountId,
    serviceId: event.serviceId,
  }, current)) {
    await deps.markAccepted(event);
    return;
  }

  const route = await deps.resolveAssistant(event);
  if (!route || !route.wakeEnabled) {
    await deps.markAccepted(event);
    return;
  }
  const selectedAssistant = route.assistantId;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(selectedAssistant)) throw new Error("channel_agent_route_invalid");
  const assistantId = await deps.persistAssistant(event, route);
  // A route may change while a delivery is being retried. Drop a queued event whose durable
  // target no longer matches the owner-selected active route rather than waking the old target.
  if (!assistantId || assistantId !== selectedAssistant) {
    await deps.markAccepted(event);
    return;
  }
  const sessionId = await deps.stableSessionId(event, assistantId);
  const reference = {
    provider: "agentmail",
    service_id: event.serviceId,
    account_id: event.accountId,
    subscription_id: event.subscriptionId,
    event_id: event.eventId,
    delivery_id: event.deliveryId,
    event_type: event.eventType,
    thread_ref: event.threadRef,
    data_ref: event.dataRef,
  };
  await deps.persistSessionId(event, sessionId);
  await deps.ensureSession(event, sessionId, assistantId);
  await deps.appendReference(event, sessionId, reference);
  const runId = await stableAgentPortEventRunId(event, assistantId);
  const accepted = await deps.wake({ event, sessionId, assistantId, runId, reference });
  if (!accepted) {
    await deps.markFailed(event);
    throw new Error("channel_agent_dispatch_failed");
  }
  await deps.markAccepted(event);
}
