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

  it("rejects wrong-type, control-bearing, oversized identities and invalid timestamps", () => {
    const base = { channel: "telegram", senderId: "chat", text: "hi", externalId: "m", timestamp: 1 };
    expect(() => toNormalizedInboundMessage({ ...base, senderId: 42 } as never)).toThrow("invalid_normalized_inbound_message");
    expect(() => toNormalizedInboundMessage({ ...base, senderId: "chat\nforged" })).toThrow("invalid_normalized_inbound_message");
    expect(() => toNormalizedInboundMessage({ ...base, externalId: "x".repeat(513) })).toThrow("invalid_normalized_inbound_message");
    for (const timestamp of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY]) {
      expect(() => toNormalizedInboundMessage({ ...base, timestamp })).toThrow("invalid_normalized_inbound_message");
    }
  });

  it("caps UTF-8 payload size while accepting a payload exactly at the ceiling", () => {
    const exact = "🙂".repeat(1024 * 1024 / 4);
    expect(toNormalizedInboundMessage({ channel: "telegram", senderId: "chat", text: exact, externalId: "m", timestamp: 1 }).payload.text).toBe(exact);
    expect(() => toNormalizedInboundMessage({ channel: "telegram", senderId: "chat", text: `${exact}x`, externalId: "m", timestamp: 1 }))
      .toThrow("invalid_normalized_inbound_message");
  });

  it("validates and detaches bounded attachment metadata", () => {
    const attachment = { type: "image" as const, url: "https://cdn.example.test/image.png?sig=opaque", mimeType: "image/png" };
    const message = toNormalizedInboundMessage({ channel: "telegram", senderId: "chat", text: "", externalId: "m", timestamp: 1, attachments: [attachment] });
    attachment.url = "https://attacker.example/changed";
    expect(message.payload.attachments).toEqual([{ type: "image", url: "https://cdn.example.test/image.png?sig=opaque", mimeType: "image/png" }]);
    expect(() => toNormalizedInboundMessage({ channel: "telegram", senderId: "chat", text: "", externalId: "m", timestamp: 1,
      attachments: [{ type: "image", url: "javascript:alert(1)", mimeType: "image/png" }] })).toThrow("invalid_normalized_inbound_message");
    expect(() => toNormalizedInboundMessage({ channel: "telegram", senderId: "chat", text: "", externalId: "m", timestamp: 1,
      attachments: Array.from({ length: 21 }, () => attachment) })).toThrow("invalid_normalized_inbound_message");
  });
});
