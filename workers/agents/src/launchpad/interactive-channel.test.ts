import { describe, expect, it } from "vitest";
import { getAdapter, twilioWhatsappAdapter } from "./channels.js";
describe("mobile review ingress identity", () => {
  it("accepts Telegram controls only from the sender's private chat", () => {
    const adapter = getAdapter("telegram")!;
    const callback = { id: "event", from: { id: 42 }, data: "review:approval", message: { chat: { id: 42, type: "private" } } };
    expect(adapter.normalizeInbound({ callback_query: callback })).toMatchObject({ channel_user_id: "42", text: "review:approval" });
    expect(adapter.normalizeInbound({ callback_query: { ...callback, message: { chat: { id: -7, type: "group" } } } })).toBeNull();
    expect(adapter.normalizeInbound({ callback_query: { ...callback, data: "approve:approval" } })).toBeNull();
  });
  it("verifies Telegram webhook bearer secrets and keeps group replies addressed to the chat", async () => {
    const adapter = getAdapter("telegram")!;
    expect(await adapter.verifySignature({ rawBody: "{}", headers: { "x-telegram-bot-api-secret-token": "secret-a" }, secret: "secret-a" })).toBe(true);
    expect(await adapter.verifySignature({ rawBody: "{}", headers: { "x-telegram-bot-api-secret-token": "secret-b" }, secret: "secret-a" })).toBe(false);
    expect(adapter.normalizeInbound({ message: { message_id: 12, date: 1, text: "hello", chat: { id: -123, type: "group" }, from: { id: 42 } } }))
      .toMatchObject({ channel_user_id: "42", recipient_id: "-123", external_id: "-123:12" });
  });
  it("keeps WhatsApp review-button replies as controls without accepting arbitrary button commands", () => {
    const adapter = getAdapter("whatsapp")!;
    const payload = (id: string) => ({ entry: [{ changes: [{ value: { messages: [{ from: "123", id: "event", timestamp: "1", interactive: { button_reply: { id } } }] } }] }] });
    expect(adapter.normalizeInbound(payload("review:approval"))).toMatchObject({ channel_user_id: "123", text: "review:approval" });
    expect(adapter.normalizeInbound(payload("approve:approval"))).toBeNull();
  });
  it("retains only voice-note identity until the signed media is authorized and transcribed", () => {
    const adapter = getAdapter("whatsapp")!;
    const payload = { entry: [{ changes: [{ value: { messages: [{ from: "15551234567", id: "wamid-audio", timestamp: "1", type: "audio", audio: { id: "meta-media" } }] } }] }] };
    expect(adapter.normalizeInbound(payload)).toMatchObject({ channel_user_id: "15551234567", external_id: "wamid-audio", text: "" });
  });
  it("recognizes Twilio voice media while requiring a real message id", () => {
    const adapter = twilioWhatsappAdapter;
    expect(adapter.normalizeInbound({ From: "whatsapp:+15551234567", MessageSid: "SM1", NumMedia: "1", MediaContentType0: "audio/ogg" }))
      .toMatchObject({ channel_user_id: "+15551234567", external_id: "SM1", text: "" });
    expect(adapter.normalizeInbound({ From: "whatsapp:+15551234567", NumMedia: "1", MediaContentType0: "audio/ogg" })).toBeNull();
  });
});
