import { describe, expect, it, vi } from "vitest";
import { dispatchAgentPortProviderEvent, stableAgentPortEventRunId } from "./agentport-provider-event-dispatch.js";
import type { ProviderEventReferenceQueueMessage } from "./session-queue.js";

const event: ProviderEventReferenceQueueMessage = {
  type: "provider_event_reference", tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a",
  agentId: "agentport-agent-a", connectionId: "connection-a", accountId: "account-a", subscriptionId: "subscription-a",
  eventId: "event-a", deliveryId: "delivery-a", serviceId: "agentmail:tenant-a", eventType: "message.received",
  threadRef: "thread-a", dataRef: "message-a",
};

describe("AgentPort provider-event dispatcher integration", () => {
  it("derives a stable runtime run key from the provider delivery and selected assistant", async () => {
    const runId = await stableAgentPortEventRunId(event, "specialist-a");
    expect(runId).toMatch(/^agentport-event-[a-f0-9]{64}$/);
    expect(await stableAgentPortEventRunId(event, "specialist-a")).toBe(runId);
    expect(await stableAgentPortEventRunId(event, "specialist-b")).not.toBe(runId);
  });

  it("rechecks the exact subscription, persists one stable conversation reference, then wakes the mapped runtime", async () => {
    const calls: string[] = [];
    const deps = {
      currentSubscription: vi.fn(async () => { calls.push("subscription"); return { subscriptionId: event.subscriptionId, agentId: event.agentId,
        accountId: event.accountId, serviceId: event.serviceId, status: "active" }; }),
      resolveAssistant: vi.fn(async () => { calls.push("assistant-route"); return { assistantId: "specialist-a", wakeEnabled: true, routeRevision: 2 }; }),
      persistAssistant: vi.fn(async (_event, route) => { calls.push(`persist-assistant:${route.assistantId}`); return route.assistantId; }),
      stableSessionId: vi.fn(async (_event, assistantId) => { calls.push("session-id"); expect(assistantId).toBe("specialist-a"); return "channel-stable"; }),
      persistSessionId: vi.fn(async (_event, sessionId) => { calls.push(`persist:${sessionId}`); }),
      ensureSession: vi.fn(async (_event, sessionId, assistantId) => { calls.push(`session:${assistantId}:${sessionId}`); }),
      appendReference: vi.fn(async (_event, sessionId, reference) => { calls.push(`append:${sessionId}`);
        expect(reference).toMatchObject({ provider: "agentmail", event_id: event.eventId, data_ref: event.dataRef });
        expect(JSON.stringify(reference)).not.toContain("body"); }),
      wake: vi.fn(async input => { calls.push(`wake:${input.assistantId}:${input.sessionId}`); return true; }),
      markAccepted: vi.fn(async () => { calls.push("accepted"); }),
      markFailed: vi.fn(async () => { calls.push("failed"); }),
    };

    await dispatchAgentPortProviderEvent(event, deps);

    expect(calls).toEqual(["subscription", "assistant-route", "persist-assistant:specialist-a", "session-id", "persist:channel-stable", "session:specialist-a:channel-stable", "append:channel-stable", "wake:specialist-a:channel-stable", "accepted"]);
    expect(deps.wake).toHaveBeenCalledOnce();
    expect(deps.markFailed).not.toHaveBeenCalled();
  });

  it("acknowledges a revoked or identity-mismatched subscription without creating a session or waking", async () => {
    const deps = {
      currentSubscription: vi.fn(async () => ({ subscriptionId: event.subscriptionId, agentId: "other-agent", accountId: event.accountId, serviceId: event.serviceId, status: "active" })),
      resolveAssistant: vi.fn(async () => ({ assistantId: "naelao-agent", wakeEnabled: true, routeRevision: 0 })), persistAssistant: vi.fn(async () => "naelao-agent"),
      stableSessionId: vi.fn(async () => "unused"), persistSessionId: vi.fn(async () => undefined),
      ensureSession: vi.fn(async () => undefined), appendReference: vi.fn(async () => undefined), wake: vi.fn(async () => true),
      markAccepted: vi.fn(async () => undefined), markFailed: vi.fn(async () => undefined),
    };

    await dispatchAgentPortProviderEvent(event, deps);

    expect(deps.markAccepted).toHaveBeenCalledOnce();
    expect(deps.stableSessionId).not.toHaveBeenCalled();
    expect(deps.ensureSession).not.toHaveBeenCalled();
    expect(deps.wake).not.toHaveBeenCalled();
  });

  it("marks failed wake attempts for queue retry", async () => {
    const deps = {
      currentSubscription: vi.fn(async () => ({ subscriptionId: event.subscriptionId, agentId: event.agentId, accountId: event.accountId, serviceId: event.serviceId, status: "active" })),
      resolveAssistant: vi.fn(async () => ({ assistantId: "naelao-agent", wakeEnabled: true, routeRevision: 0 })), persistAssistant: vi.fn(async () => "naelao-agent"),
      stableSessionId: vi.fn(async () => "channel-stable"), persistSessionId: vi.fn(async () => undefined),
      ensureSession: vi.fn(async () => undefined), appendReference: vi.fn(async () => undefined), wake: vi.fn(async () => false),
      markAccepted: vi.fn(async () => undefined), markFailed: vi.fn(async () => undefined),
    };

    await expect(dispatchAgentPortProviderEvent(event, deps)).rejects.toThrow("channel_agent_dispatch_failed");
    expect(deps.markFailed).toHaveBeenCalledOnce();
    expect(deps.markAccepted).not.toHaveBeenCalled();
  });

  it("drops a delivery when its durable assistant target no longer matches the active route", async () => {
    const deps = {
      currentSubscription: vi.fn(async () => ({ subscriptionId: event.subscriptionId, agentId: event.agentId,
        accountId: event.accountId, serviceId: event.serviceId, status: "active" })),
      resolveAssistant: vi.fn(async () => ({ assistantId: "specialist-b", wakeEnabled: true, routeRevision: 3 })), persistAssistant: vi.fn(async () => "specialist-a"),
      stableSessionId: vi.fn(async () => "unused"), persistSessionId: vi.fn(async () => undefined),
      ensureSession: vi.fn(async () => undefined), appendReference: vi.fn(async () => undefined), wake: vi.fn(async () => true),
      markAccepted: vi.fn(async () => undefined), markFailed: vi.fn(async () => undefined),
    };
    await dispatchAgentPortProviderEvent(event,deps);
    expect(deps.markAccepted).toHaveBeenCalledOnce();
    expect(deps.stableSessionId).not.toHaveBeenCalled();
    expect(deps.wake).not.toHaveBeenCalled();
  });

  it("accepts a valid event without waking when the owner paused the event subscription", async () => {
    const deps = {
      currentSubscription: vi.fn(async () => ({ subscriptionId: event.subscriptionId, agentId: event.agentId,
        accountId: event.accountId, serviceId: event.serviceId, status: "active" })),
      resolveAssistant: vi.fn(async () => ({ assistantId: "specialist-a", wakeEnabled: false, routeRevision: 2 })),
      persistAssistant: vi.fn(async () => "specialist-a"), stableSessionId: vi.fn(async () => "unused"),
      persistSessionId: vi.fn(async () => undefined), ensureSession: vi.fn(async () => undefined),
      appendReference: vi.fn(async () => undefined), wake: vi.fn(async () => true),
      markAccepted: vi.fn(async () => undefined), markFailed: vi.fn(async () => undefined),
    };
    await dispatchAgentPortProviderEvent(event, deps);
    expect(deps.markAccepted).toHaveBeenCalledOnce();
    expect(deps.persistAssistant).not.toHaveBeenCalled();
    expect(deps.ensureSession).not.toHaveBeenCalled();
    expect(deps.wake).not.toHaveBeenCalled();
  });

  it("drops a delivery when its owner-selected route belongs to a replaced subscription", async () => {
    const deps = {
      currentSubscription: vi.fn(async () => ({ subscriptionId: event.subscriptionId, agentId: event.agentId,
        accountId: event.accountId, serviceId: event.serviceId, status: "active" })),
      resolveAssistant: vi.fn(async () => null), persistAssistant: vi.fn(async () => null),
      stableSessionId: vi.fn(async () => "unused"), persistSessionId: vi.fn(async () => undefined),
      ensureSession: vi.fn(async () => undefined), appendReference: vi.fn(async () => undefined), wake: vi.fn(async () => true),
      markAccepted: vi.fn(async () => undefined), markFailed: vi.fn(async () => undefined),
    };
    await dispatchAgentPortProviderEvent(event, deps);
    expect(deps.markAccepted).toHaveBeenCalledOnce();
    expect(deps.persistAssistant).not.toHaveBeenCalled();
    expect(deps.wake).not.toHaveBeenCalled();
  });
});
