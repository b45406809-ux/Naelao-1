import { describe, expect, it } from "vitest";
import { getAdapter } from "./channels.js";
describe("mobile review ingress identity", () => {
  it("accepts Telegram controls only from the sender's private chat", () => {
    const adapter = getAdapter("telegram")!;
    const callback = { id: "event", from: { id: 42 }, data: "review:approval", message: { chat: { id: 42, type: "private" } } };
    expect(adapter.normalizeInbound({ callback_query: callback })).toMatchObject({ channel_user_id: "42", text: "review:approval" });
    expect(adapter.normalizeInbound({ callback_query: { ...callback, message: { chat: { id: -7, type: "group" } } } })).toBeNull();
    expect(adapter.normalizeInbound({ callback_query: { ...callback, data: "approve:approval" } })).toBeNull();
  });
  it("keeps WhatsApp review-button replies as controls without accepting arbitrary button commands", () => {
    const adapter = getAdapter("whatsapp")!;
    const payload = (id: string) => ({ entry: [{ changes: [{ value: { messages: [{ from: "123", id: "event", timestamp: "1", interactive: { button_reply: { id } } }] } }] }] });
    expect(adapter.normalizeInbound(payload("review:approval"))).toMatchObject({ channel_user_id: "123", text: "review:approval" });
    expect(adapter.normalizeInbound(payload("approve:approval"))).toBeNull();
  });
});
