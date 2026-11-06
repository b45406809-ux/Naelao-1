import { describe, expect, it, vi } from "vitest";
import {
  type QueueMessageLike,
  handleChannelSessionQueue,
  isChannelSessionQueueMessage,
} from "./session-queue.js";

function queueMessage(body: unknown) {
  const ack = vi.fn();
  const retry = vi.fn();
  return {
    message: {
      id: "queue-message-1",
      body,
      ack,
      retry,
    } satisfies QueueMessageLike,
    ack,
    retry,
  };
}

const inbound = {
  type: "inbound_channel",
  channel_type: "slack",
  space_id: "space-a",
  tenant_id: "tenant-a",
  project_id: "project-a",
  end_user_id: "slack:user-a",
  content: "hello",
  metadata: { slack_ts: "1" },
};
const providerEvent={type:"provider_event_reference",tenantId:"tenant-a",spaceId:"space-a",projectId:"project-a",agentId:"naelao_agent-a",connectionId:"conn-a",accountId:"acct-a",subscriptionId:"sub-a",eventId:"evt-a",deliveryId:"delivery-a",serviceId:"email-provider-a",eventType:"message.received",threadRef:"provider-thread-a",dataRef:"provider-message-a"};

describe("channel session queue", () => {
  it("validates both supported message shapes and rejects oversized content", () => {
    expect(isChannelSessionQueueMessage(inbound)).toBe(true);
    expect(isChannelSessionQueueMessage(providerEvent)).toBe(true);
    expect(isChannelSessionQueueMessage({...providerEvent,body:"must-not-be-queued"})).toBe(false);
    expect(
      isChannelSessionQueueMessage({
        type: "space_trigger",
        spaceId: "s",
        projectId: "p",
        tenantId: "t",
        message: "go",
      })
    ).toBe(true);
    expect(
      isChannelSessionQueueMessage({ ...inbound, content: "x".repeat(100_001) })
    ).toBe(false);
    expect(isChannelSessionQueueMessage({ ...inbound, metadata: [] })).toBe(
      false
    );
    expect(isChannelSessionQueueMessage({...providerEvent,deliveryId:""})).toBe(false);
  });

  it("acks successful dispatches and retries transient failures without stopping the batch", async () => {
    const first = queueMessage(inbound);
    const second = queueMessage(inbound);
    const process = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("temporary"));
    const logError = vi.fn();

    await handleChannelSessionQueue([first.message, second.message], {
      process,
      logError,
    });

    expect(first.ack).toHaveBeenCalledOnce();
    expect(first.retry).not.toHaveBeenCalled();
    expect(second.ack).not.toHaveBeenCalled();
    expect(second.retry).toHaveBeenCalledOnce();
    expect(logError).toHaveBeenCalledOnce();
    expect(process).toHaveBeenNthCalledWith(1, inbound, "queue-message-1");
  });

  it("acks malformed poison messages instead of retrying them forever", async () => {
    const poison = queueMessage({ type: "unexpected" });
    const process = vi.fn();
    const logError = vi.fn();

    await handleChannelSessionQueue([poison.message], { process, logError });

    expect(process).not.toHaveBeenCalled();
    expect(poison.ack).toHaveBeenCalledOnce();
    expect(poison.retry).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledOnce();
  });
});
