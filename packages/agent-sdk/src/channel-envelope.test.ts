import { describe, expect, it } from "vitest";
import { toNormalizedInboundMessage } from "./channel-envelope.js";

describe("universal inbound channel envelope", () => {
  it("normalizes channel identity while preserving per-sender session and safe provider metadata", () => {
    expect(toNormalizedInboundMessage({ channel: "telegram", senderId: "chat-42", text: "hello", externalId: "m-1", timestamp: 1234 }))
      .toEqual({
        channelId: "ext_channel_telegram",
        sessionKey: "telegram:chat-42",
        sender: { id: "chat-42" },
        payload: { text: "hello", attachments: [] },
        rawMetadata: { externalId: "m-1", timestamp: 1234 },
      });
  });

  it("rejects malformed channel identity and does not accept secret-bearing raw payloads", () => {
    expect(() => toNormalizedInboundMessage({ channel: "telegram:token", senderId: "chat", text: "hi", externalId: "m", timestamp: 1 })).toThrow("invalid_normalized_inbound_message");
    expect(() => toNormalizedInboundMessage({ channel: "telegram", senderId: "", text: "hi", externalId: "m", timestamp: 1 })).toThrow("invalid_normalized_inbound_message");
  });
});
